import type { Direction, Nulls } from './index.ts';
import { InvalidColumnNameError } from './errors.ts';

export type Dialect = 'postgres' | 'mysql' | 'sqlite';
export type Placeholder = 'numbered' | 'question';

const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a `name` or `table.name` identifier, never letting it through unchecked. */
export function assertValidIdentifier(name: string): void {
  const parts = name.split('.');
  if (parts.length === 0 || parts.length > 2 || parts.some((p) => !IDENT_PART.test(p))) {
    throw new InvalidColumnNameError(name);
  }
}

/**
 * Quote an identifier for the target dialect. Postgres and SQLite use `"`,
 * MySQL uses `` ` ``; both escape an embedded quote by doubling it. Applied
 * per dot-separated part so `table.column` quotes as `"table"."column"`.
 */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  assertValidIdentifier(name);
  const quote = dialect === 'mysql' ? '`' : '"';
  return name
    .split('.')
    .map((part) => quote + part.replace(new RegExp(quote, 'g'), quote + quote) + quote)
    .join('.');
}

/**
 * The NULLS placement a column gets when the caller doesn't say `nulls`
 * explicitly, per dialect and direction. Verified against real engines
 * (pglite for postgres, node:sqlite for sqlite; see test/dialect.test.ts).
 * MySQL is not run in this repo's tests — no in-process server exists for
 * it — but its default null ordering (NULL sorts as the smallest value) is
 * long-documented and unchanged across MySQL 5.7 through 8.x.
 */
export function defaultNulls(dialect: Dialect, direction: Direction): Nulls {
  if (dialect === 'postgres') {
    // Postgres treats NULL as larger than any non-null value by default.
    return direction === 'asc' ? 'last' : 'first';
  }
  // MySQL and SQLite treat NULL as smaller than any non-null value by default.
  return direction === 'asc' ? 'first' : 'last';
}

/** Whether the dialect can express `NULLS FIRST`/`NULLS LAST` in `ORDER BY` directly. */
export function supportsNullsClause(dialect: Dialect): boolean {
  return dialect === 'postgres' || dialect === 'sqlite';
}

export function defaultPlaceholder(dialect: Dialect): Placeholder {
  return dialect === 'postgres' ? 'numbered' : 'question';
}
