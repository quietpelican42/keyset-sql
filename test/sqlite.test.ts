import assert from 'node:assert/strict';
import { test, describe, before } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { keyset } from '../src/index.ts';
import type { Engine, Row } from './helpers.ts';
import { pageForward, pageBackward, randomRows, mulberry32 } from './helpers.ts';

let db: DatabaseSync;
let engine: Engine;

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)');
  const insert = db.prepare('INSERT INTO t (id, a, b) VALUES (?, ?, ?)');
  for (const row of randomRows(mulberry32(1), 60)) insert.run(row.id, row.a, row.b);

  engine = {
    dialect: 'sqlite',
    async run(sql, params) {
      return db.prepare(sql).all(...(params as never[])) as unknown as Row[];
    },
  };
});

describe('sqlite: NULLS default verification', () => {
  test('ASC sorts NULLs first by default', async () => {
    const rows = await engine.run('SELECT id FROM t WHERE a IS NULL OR a = 0 ORDER BY a ASC LIMIT 3', []);
    const withNull = await engine.run('SELECT a FROM t ORDER BY a ASC LIMIT 1', []);
    assert.equal(withNull[0]!.a, null);
  });

  test('DESC sorts NULLs last by default', async () => {
    const rows = await engine.run('SELECT a FROM t ORDER BY a DESC LIMIT 1', []);
    // the last row in DESC order should be null if any nulls exist (they do, given the domain)
    const lastRows = await engine.run('SELECT a FROM t ORDER BY a DESC', []);
    assert.equal(lastRows[lastRows.length - 1]!.a, null);
  });
});

describe('sqlite: tie-drop with a single-column cursor vs a composite one', () => {
  test('single-column cursor on a tied column drops rows', async () => {
    // Force ties: everything shares a = 1.
    const tie = new DatabaseSync(':memory:');
    tie.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
    const insert = tie.prepare('INSERT INTO t (id, a) VALUES (?, ?)');
    for (let id = 1; id <= 5; id++) insert.run(id, 1);

    // Naive cursor: WHERE a > ? using only the tied column. After reading the
    // first row (a=1), "a > 1" matches nothing else, even though 4 rows remain.
    const first = tie.prepare('SELECT * FROM t ORDER BY a ASC LIMIT 1').all()[0] as unknown as Row;
    const next = tie.prepare('SELECT * FROM t WHERE a > ? ORDER BY a ASC LIMIT 10').all(first.a);
    assert.equal(next.length, 0, 'naive single-column cursor silently drops the remaining tied rows');
  });

  test('composite (a, id) cursor from keyset() does not drop the tied rows', async () => {
    const tie = new DatabaseSync(':memory:');
    tie.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
    const insert = tie.prepare('INSERT INTO t (id, a) VALUES (?, ?)');
    for (let id = 1; id <= 5; id++) insert.run(id, 1);

    const columns = [
      { name: 'a', direction: 'asc' as const },
      { name: 'id', direction: 'asc' as const, unique: true, notNull: true },
    ];
    const first = keyset({ columns, dialect: 'sqlite' });
    const firstRows = tie.prepare(`SELECT * FROM t ORDER BY ${first.orderBy} LIMIT 1`).all() as unknown as Row[];
    assert.equal(firstRows.length, 1);

    const cursor = { after: { a: firstRows[0]!.a, id: firstRows[0]!.id } };
    const { where, orderBy, params } = keyset({ columns, cursor, dialect: 'sqlite' });
    const rest = tie
      .prepare(`SELECT * FROM t WHERE ${where} ORDER BY ${orderBy} LIMIT 10`)
      .all(...(params as never[])) as unknown as Row[];
    assert.equal(rest.length, 4, 'all 4 remaining tied rows are returned');
  });
});

describe('sqlite: paging through a fixed table matches a plain ORDER BY', () => {
  test('forward, ascending composite cursor', async () => {
    const truth = (await engine.run('SELECT id FROM t ORDER BY a ASC, b ASC, id ASC', [])).map((r) => r.id);
    const cfg = { columns: [{ name: 'a' as const, direction: 'asc' as const }, { name: 'b' as const, direction: 'asc' as const }], idDirection: 'asc' as const };
    const paged = await pageForward(engine, cfg, 7);
    assert.deepEqual(paged, truth);
  });

  test('forward, mixed directions with explicit NULLS override', async () => {
    const truth = (
      await engine.run('SELECT id FROM t ORDER BY a DESC NULLS FIRST, b ASC NULLS LAST, id DESC', [])
    ).map((r) => r.id);
    const cfg = {
      columns: [
        { name: 'a' as const, direction: 'desc' as const, nulls: 'first' as const },
        { name: 'b' as const, direction: 'asc' as const, nulls: 'last' as const },
      ],
      idDirection: 'desc' as const,
    };
    const paged = await pageForward(engine, cfg, 5);
    assert.deepEqual(paged, truth);
  });

  test('backward paging from an interior cursor reconstructs the prefix in order', async () => {
    const truth = (await engine.run('SELECT * FROM t ORDER BY a ASC, id ASC', [])) as unknown as Row[];
    const splitIndex = 37;
    const anchor = truth[splitIndex]!;
    const expected = truth.slice(0, splitIndex).map((r) => r.id);

    const cfg = { columns: [{ name: 'a' as const, direction: 'asc' as const }], idDirection: 'asc' as const };
    const got = await pageBackward(engine, cfg, anchor, 6);
    assert.deepEqual(got, expected);
  });
});
