/**
 * Shared harness for the sqlite/postgres integration and property tests.
 * Not a test file itself (doesn't match `*.test.ts`).
 */
import { keyset, type Dialect, type KeysetColumn } from '../src/index.ts';

export interface Row {
  id: number;
  a: number | null;
  b: string | null;
}

export interface Engine {
  dialect: Dialect;
  /** Run a query and return rows as plain objects. */
  run(sql: string, params: unknown[]): Promise<Row[]>;
}

/** Deterministic PRNG so a failing property run can be reproduced from the seed printed in the failure. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ColumnConfig {
  name: 'a' | 'b';
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface TableConfig {
  columns: ColumnConfig[]; // leading columns, before the mandatory unique `id` tiebreaker
  idDirection: 'asc' | 'desc';
}

export function randomTableConfig(rand: () => number): TableConfig {
  const n = 1 + Math.floor(rand() * 2); // 1 or 2 leading columns
  const pool: Array<'a' | 'b'> = rand() < 0.5 ? ['a', 'b'] : ['b', 'a'];
  const columns: ColumnConfig[] = pool.slice(0, n).map((name) => {
    const direction = rand() < 0.5 ? 'asc' : 'desc';
    const nulls = rand() < 0.5 ? undefined : rand() < 0.5 ? 'first' : 'last';
    return { name, direction, nulls };
  });
  return { columns, idDirection: rand() < 0.5 ? 'asc' : 'desc' };
}

export function toKeysetColumns(cfg: TableConfig): KeysetColumn[] {
  return [
    ...cfg.columns.map((c) => ({ name: c.name, direction: c.direction, nulls: c.nulls })),
    { name: 'id', direction: cfg.idDirection, unique: true },
  ];
}

export function randomRows(rand: () => number, count: number): Row[] {
  const aDomain = [null, 0, 1, 2, 3];
  const bDomain = [null, 'x', 'y', 'z'];
  const rows: Row[] = [];
  for (let id = 1; id <= count; id++) {
    rows.push({
      id,
      a: aDomain[Math.floor(rand() * aDomain.length)]!,
      b: bDomain[Math.floor(rand() * bDomain.length)]!,
    });
  }
  return rows;
}

function orderByClauseForTruth(cfg: TableConfig, dialect: Dialect): string {
  // The "ground truth" ordering: an ordinary ORDER BY over the same columns,
  // using each engine's own default NULLS placement when not overridden.
  const parts = [...cfg.columns.map((c) => ({ name: c.name, direction: c.direction, nulls: c.nulls })), { name: 'id', direction: cfg.idDirection, nulls: undefined as 'first' | 'last' | undefined }];
  return parts
    .map((c) => {
      const dir = c.direction.toUpperCase();
      if (!c.nulls) return `${c.name} ${dir}`;
      if (dialect === 'mysql') {
        // exercised only conceptually; mysql has no live engine in this suite
        const prefixDir = c.nulls === 'last' ? 'ASC' : 'DESC';
        return `(${c.name} IS NULL) ${prefixDir}, ${c.name} ${dir}`;
      }
      return `${c.name} ${dir} NULLS ${c.nulls.toUpperCase()}`;
    })
    .join(', ');
}

/** The full, correct ordering for a table config, straight from one ORDER BY query. */
export async function truthOrder(engine: Engine, cfg: TableConfig): Promise<number[]> {
  const rows = await engine.run(`SELECT id FROM t ORDER BY ${orderByClauseForTruth(cfg, engine.dialect)}`, []);
  return rows.map((r) => r.id);
}

/** Page forward through the whole table using keyset(), returning ids in the order fetched. */
export async function pageForward(
  engine: Engine,
  cfg: TableConfig,
  pageSize: (() => number) | number,
): Promise<number[]> {
  const columns = toKeysetColumns(cfg);
  const ids: number[] = [];
  let cursor: { after: Record<string, unknown> } | undefined;

  for (let guard = 0; guard < 10_000; guard++) {
    const size = typeof pageSize === 'function' ? pageSize() : pageSize;
    const { where, orderBy, params } = keyset({ columns, cursor, dialect: engine.dialect });
    const limitPlaceholder = engine.dialect === 'postgres' ? `$${params.length + 1}` : '?';
    const sql = `SELECT * FROM t ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT ${limitPlaceholder}`;
    const rows = await engine.run(sql, [...params, size]);
    if (rows.length === 0) break;
    for (const r of rows) ids.push(r.id);
    const last = rows[rows.length - 1]!;
    cursor = { after: pick(last, columns) };
    if (rows.length < size) break;
  }
  return ids;
}

/** Page backward from `startAfterId` (exclusive) to the start of the table. */
export async function pageBackward(
  engine: Engine,
  cfg: TableConfig,
  anchor: Row,
  pageSize: (() => number) | number,
): Promise<number[]> {
  const columns = toKeysetColumns(cfg);
  const collected: number[] = [];
  let cursor: Record<string, unknown> = pick(anchor, columns);

  for (let guard = 0; guard < 10_000; guard++) {
    const size = typeof pageSize === 'function' ? pageSize() : pageSize;
    const { where, orderBy, params, reversed } = keyset({
      columns,
      cursor: { before: cursor },
      dialect: engine.dialect,
    });
    if (!reversed) throw new Error('expected reversed=true for a before cursor');
    const limitPlaceholder = engine.dialect === 'postgres' ? `$${params.length + 1}` : '?';
    const sql = `SELECT * FROM t ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT ${limitPlaceholder}`;
    const rows = await engine.run(sql, [...params, size]);
    if (rows.length === 0) break;
    rows.reverse(); // undo the flipped ORDER BY to restore ascending page order
    collected.unshift(...rows.map((r) => r.id));
    cursor = pick(rows[0]!, columns);
    if (rows.length < size) break;
  }
  return collected;
}

function pick(row: Row, columns: KeysetColumn[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c.name] = (row as unknown as Record<string, unknown>)[c.name];
  return out;
}
