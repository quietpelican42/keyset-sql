/**
 * Shows the bug this package exists to avoid: a naive single-column cursor
 * on a column with ties silently drops rows, on a real SQLite database.
 *
 *   node examples/tie-drop-demo.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { keyset } from '../src/index.ts';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, created_at INTEGER)');
const insert = db.prepare('INSERT INTO events (id, created_at) VALUES (?, ?)');
// Five events land in the same second — an ordinary occurrence under load,
// or with a coarse timestamp column.
const rows = [
  { id: 1, created_at: 1000 },
  { id: 2, created_at: 1000 },
  { id: 3, created_at: 1000 },
  { id: 4, created_at: 1000 },
  { id: 5, created_at: 1000 },
  { id: 6, created_at: 1001 },
];
for (const r of rows) insert.run(r.id, r.created_at);

console.log('\n6 rows, 5 of them tied on created_at = 1000\n');

// --- naive: cursor on created_at alone -------------------------------
console.log('naive cursor (created_at only), page size 2:');
{
  let cursor: number | undefined;
  const seen: number[] = [];
  for (let page = 0; page < 5; page++) {
    const sql = cursor
      ? 'SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT 2'
      : 'SELECT * FROM events ORDER BY created_at ASC LIMIT 2';
    const got = (cursor ? db.prepare(sql).all(cursor) : db.prepare(sql).all()) as {
      id: number;
      created_at: number;
    }[];
    if (got.length === 0) break;
    for (const r of got) seen.push(r.id);
    cursor = got[got.length - 1]!.created_at;
  }
  console.log(`  visited ids: [${seen.join(', ')}]  (${seen.length}/6 rows — the rest tie away)`);
}

// --- keyset-sql: composite (created_at, id) cursor --------------------
console.log('\nkeyset-sql cursor (created_at, id), page size 2:');
{
  const columns = [
    { name: 'created_at', direction: 'asc' as const },
    { name: 'id', direction: 'asc' as const, unique: true, notNull: true },
  ];
  let cursor: { after: { created_at: number; id: number } } | undefined;
  const seen: number[] = [];
  for (let page = 0; page < 5; page++) {
    const { where, orderBy, params } = keyset({ columns, cursor, dialect: 'sqlite' });
    const sql = `SELECT * FROM events ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT 2`;
    const got = db.prepare(sql).all(...(params as never[])) as { id: number; created_at: number }[];
    if (got.length === 0) break;
    for (const r of got) seen.push(r.id);
    const last = got[got.length - 1]!;
    cursor = { after: { created_at: last.created_at, id: last.id } };
  }
  console.log(`  visited ids: [${seen.join(', ')}]  (${seen.length}/6 rows)`);
}
console.log();
