import {
  quoteIdentifier,
  defaultNulls,
  supportsNullsClause,
  defaultPlaceholder,
  type Dialect,
  type Placeholder,
} from './dialect.ts';
import { MissingTiebreakerError, NoColumnsError, MissingCursorValueError } from './errors.ts';

export type { Dialect, Placeholder } from './dialect.ts';
export * from './errors.ts';
export { encodeCursor, decodeCursor, type CursorOptions } from './cursor.ts';

export type Direction = 'asc' | 'desc';
export type Nulls = 'first' | 'last';

export interface KeysetColumn {
  /** Column name, or `table.column`. Validated and quoted — never interpolated raw. */
  name: string;
  direction: Direction;
  /**
   * Where NULLs sort. Defaults to the dialect's own `ORDER BY` default for
   * this direction (verified against real engines — see `src/dialect.ts`).
   * Set explicitly to override that default; keyset-sql then reproduces it
   * even on dialects (MySQL) that have no `NULLS FIRST/LAST` syntax.
   */
  nulls?: Nulls;
  /**
   * Assert that this column can never be `NULL` in the table. Two effects:
   * it drops the unreachable `OR col IS NULL` arm this column would
   * otherwise need in the OR-chain form, and — only when *every* column
   * carries it and directions agree — it unlocks the row-value comparison
   * optimization (`(a, b) > ($1, $2)`). SQL's row comparison returns
   * NULL/unknown, not true, the moment any compared column is NULL, which
   * would silently exclude rows if the assertion were wrong; get this
   * wrong and rows go missing, so only set it on a column with a real
   * `NOT NULL` constraint.
   */
  notNull?: boolean;
  /**
   * Mark the column (usually the last one) as unique. `keyset()` requires
   * exactly the last column in `columns` to carry this — without a unique
   * tiebreaker, rows that tie on the leading columns are dropped or
   * duplicated across pages.
   */
  unique?: boolean;
}

export type CursorRow = Record<string, unknown>;

export interface KeysetOptions {
  columns: KeysetColumn[];
  /** Omit for the first page. `after` pages forward, `before` pages backward. */
  cursor?: { after: CursorRow } | { before: CursorRow };
  dialect: Dialect;
  /** Defaults to `numbered` ($1, $2, …) for postgres, `question` (?) otherwise. */
  placeholder?: Placeholder;
  /** First placeholder number, for `numbered` style. Default 1. */
  startIndex?: number;
}

export interface KeysetResult {
  /** Boolean expression, no leading `WHERE`. `''` when `cursor` was omitted. */
  where: string;
  /** Column list, no leading `ORDER BY`. Already reversed when `reversed` is true. */
  orderBy: string;
  /** Parameter values, positional in the order placeholders appear in `where`. */
  params: unknown[];
  /**
   * True for `before` paging: `orderBy` is reversed so the query can use
   * `LIMIT` to grab the page nearest the cursor. Reverse the fetched rows
   * in application code to restore ascending page order.
   */
  reversed: boolean;
}

function flip(direction: Direction): Direction {
  return direction === 'asc' ? 'desc' : 'asc';
}
function flipNulls(nulls: Nulls): Nulls {
  return nulls === 'first' ? 'last' : 'first';
}

interface ResolvedColumn {
  name: string;
  quoted: string;
  direction: Direction;
  nulls: Nulls;
  notNull: boolean;
}

function resolveColumns(columns: KeysetColumn[], dialect: Dialect, reverse: boolean): ResolvedColumn[] {
  if (columns.length === 0) throw new NoColumnsError();
  const last = columns[columns.length - 1]!;
  if (!last.unique) throw new MissingTiebreakerError();

  return columns.map((c) => {
    const direction = reverse ? flip(c.direction) : c.direction;
    const nulls = reverse
      ? flipNulls(c.nulls ?? defaultNulls(dialect, c.direction))
      : (c.nulls ?? defaultNulls(dialect, c.direction));
    return {
      name: c.name,
      quoted: quoteIdentifier(dialect, c.name),
      direction,
      nulls,
      notNull: c.notNull ?? false,
    };
  });
}

/** `col > val` for asc, `col < val` for desc — the strict, direction-aware "later" operator. */
function gtOp(direction: Direction): string {
  return direction === 'asc' ? '>' : '<';
}

class ParamList {
  values: unknown[] = [];
  private placeholder: Placeholder;
  private next: number;
  constructor(placeholder: Placeholder, startIndex: number) {
    this.placeholder = placeholder;
    this.next = startIndex;
  }
  push(value: unknown): string {
    this.values.push(value);
    if (this.placeholder === 'question') return '?';
    return `$${this.next++}`;
  }
}

/** `col = val`, null-safe (`col IS NULL` when val is null). */
function eq(col: ResolvedColumn, value: unknown, params: ParamList): string {
  return value === null ? `${col.quoted} IS NULL` : `${col.quoted} = ${params.push(value)}`;
}

/**
 * The predicate for "col sorts strictly after value", given where this
 * column's NULLs sort. Handles both a non-null cursor value (may need an
 * `OR col IS NULL` arm when NULLs sort last) and a null cursor value (the
 * cursor sits at one extreme of this column's order already). Skips the
 * NULL-handling entirely when the column is asserted `notNull` — there is
 * no other row that could match it.
 */
function after(col: ResolvedColumn, value: unknown, params: ParamList): string {
  if (value === null) {
    // A null cursor value sits at whichever extreme `nulls` puts it. Nothing
    // sorts after it if nulls are last; everything non-null does if first.
    return col.nulls === 'last' ? '1=0' : `${col.quoted} IS NOT NULL`;
  }
  const cmp = `${col.quoted} ${gtOp(col.direction)} ${params.push(value)}`;
  return col.nulls === 'last' && !col.notNull ? `(${cmp} OR ${col.quoted} IS NULL)` : cmp;
}

/**
 * Row-value comparison `(a, b) > (x, y)` is only equivalent to the OR-chain
 * when every column agrees on direction and every column is asserted
 * `notNull` — SQL's row comparison returns NULL/unknown (excluding the row)
 * the moment any compared column is NULL, regardless of `nulls` placement,
 * so it can silently drop rows on a nullable column even when the cursor's
 * own value isn't null. MySQL is excluded outright: its optimizer isn't
 * verified here to use a composite index for a row constructor comparison,
 * so it always gets the OR-chain.
 */
function canUseRowValue(cols: ResolvedColumn[], dialect: Dialect): boolean {
  if (dialect === 'mysql') return false;
  return cols.every((c) => c.notNull && c.direction === cols[0]!.direction);
}

function buildWhere(
  cols: ResolvedColumn[],
  cursorValues: unknown[],
  dialect: Dialect,
  params: ParamList,
): string {
  if (canUseRowValue(cols, dialect)) {
    const lhs = cols.map((c) => c.quoted).join(', ');
    const rhs = cursorValues.map((v) => params.push(v)).join(', ');
    const op = gtOp(cols[0]!.direction);
    return cols.length === 1 ? `${lhs} ${op} ${rhs}` : `(${lhs}) ${op} (${rhs})`;
  }

  const branches: string[] = [];
  for (let k = 0; k < cols.length; k++) {
    const prefix = cols.slice(0, k).map((c, i) => eq(c, cursorValues[i], params));
    const tail = after(cols[k]!, cursorValues[k], params);
    const parts = [...prefix, tail];
    branches.push(parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`);
  }
  return branches.length === 1 ? branches[0]! : branches.join(' OR ');
}

function buildOrderBy(cols: ResolvedColumn[], dialect: Dialect): string {
  return cols
    .map((c) => {
      const isDefault = c.nulls === defaultNulls(dialect, c.direction);
      if (isDefault || supportsNullsClause(dialect)) {
        const nullsClause = isDefault ? '' : ` NULLS ${c.nulls.toUpperCase()}`;
        return `${c.quoted} ${c.direction.toUpperCase()}${nullsClause}`;
      }
      // MySQL has no NULLS FIRST/LAST syntax. Emulate it with a leading
      // (col IS NULL) sort key: ascending puts non-null (0) before null (1).
      const prefixDir = c.nulls === 'last' ? 'ASC' : 'DESC';
      return `(${c.quoted} IS NULL) ${prefixDir}, ${c.quoted} ${c.direction.toUpperCase()}`;
    })
    .join(', ');
}

/**
 * Build the `WHERE` fragment, `ORDER BY` fragment and parameters for one
 * page of a keyset (seek) pagination query.
 *
 * ```ts
 * const { where, orderBy, params } = keyset({
 *   columns: [
 *     { name: 'created_at', direction: 'desc' },
 *     { name: 'id', direction: 'desc', unique: true },
 *   ],
 *   cursor: cursor ? { after: decodeCursor(cursor) } : undefined,
 *   dialect: 'postgres',
 * });
 * const rows = await client.query(
 *   `SELECT * FROM posts ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT $${params.length + 1}`,
 *   [...params, pageSize],
 * );
 * ```
 */
export function keyset(options: KeysetOptions): KeysetResult {
  const { columns, dialect, cursor } = options;
  const placeholder = options.placeholder ?? defaultPlaceholder(dialect);
  const startIndex = options.startIndex ?? 1;
  const reversed = cursor !== undefined && 'before' in cursor;

  const cols = resolveColumns(columns, dialect, reversed);
  const orderBy = buildOrderBy(cols, dialect);
  const params = new ParamList(placeholder, startIndex);

  if (!cursor) return { where: '', orderBy, params: [], reversed: false };

  const row = 'after' in cursor ? cursor.after : cursor.before;
  const cursorValues = cols.map((c) => {
    if (!(c.name in row)) throw new MissingCursorValueError(c.name);
    return row[c.name];
  });

  const where = buildWhere(cols, cursorValues, dialect, params);
  return { where, orderBy, params: params.values, reversed };
}

export default keyset;
