import assert from 'node:assert/strict';
import { test, describe, before, after as afterHook } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { keyset } from '../src/index.ts';
import type { Engine, Row } from './helpers.ts';
import { pageForward, pageBackward, randomRows, mulberry32 } from './helpers.ts';

let db: PGlite;
let engine: Engine;

before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)');
  for (const row of randomRows(mulberry32(2), 60)) {
    await db.query('INSERT INTO t (id, a, b) VALUES ($1, $2, $3)', [row.id, row.a, row.b]);
  }

  engine = {
    dialect: 'postgres',
    async run(sql, params) {
      const res = await db.query(sql, params);
      return res.rows as unknown as Row[];
    },
  };
});

afterHook(async () => db.close());

describe('postgres: NULLS default verification (real engine, not recalled)', () => {
  test('ASC sorts NULLs last by default', async () => {
    const rows = await engine.run('SELECT a FROM t ORDER BY a ASC', []);
    assert.equal(rows[rows.length - 1]!.a, null);
  });

  test('DESC sorts NULLs first by default', async () => {
    const rows = await engine.run('SELECT a FROM t ORDER BY a DESC', []);
    assert.equal(rows[0]!.a, null);
  });
});

describe('postgres: row-value comparison actually executes and matches the OR-chain', () => {
  test('notNull tuple form and OR-chain form return the same page', async () => {
    const columns = [
      { name: 'a', direction: 'desc' as const },
      { name: 'id', direction: 'desc' as const, unique: true },
    ];
    const columnsNotNull = [
      { name: 'a', direction: 'desc' as const, notNull: true },
      { name: 'id', direction: 'desc' as const, unique: true, notNull: true },
    ];
    // Pick a cursor with a non-null `a` so the row-value form actually applies.
    const anchor = (
      await engine.run('SELECT * FROM t WHERE a IS NOT NULL ORDER BY a DESC, id DESC LIMIT 1 OFFSET 10', [])
    )[0] as unknown as Row;

    const chain = keyset({ columns, cursor: { after: { a: anchor.a, id: anchor.id } }, dialect: 'postgres' });
    const tuple = keyset({
      columns: columnsNotNull,
      cursor: { after: { a: anchor.a, id: anchor.id } },
      dialect: 'postgres',
    });
    assert.ok(tuple.where.startsWith('('), 'expected the row-value tuple form');
    assert.doesNotMatch(chain.where, /^\(".*"\) [<>]/, 'expected the OR-chain form');

    const chainRows = (
      await engine.run(`SELECT id FROM t WHERE ${chain.where} ORDER BY ${chain.orderBy}`, chain.params)
    ).map((r) => r.id);
    const tupleRows = (
      await engine.run(`SELECT id FROM t WHERE ${tuple.where} ORDER BY ${tuple.orderBy}`, tuple.params)
    ).map((r) => r.id);
    assert.deepEqual(tupleRows, chainRows);
  });
});

describe('postgres: paging through a fixed table matches a plain ORDER BY', () => {
  test('forward, ascending composite cursor', async () => {
    const truth = (await engine.run('SELECT id FROM t ORDER BY a ASC, b ASC, id ASC', [])).map((r) => r.id);
    const cfg = {
      columns: [
        { name: 'a' as const, direction: 'asc' as const },
        { name: 'b' as const, direction: 'asc' as const },
      ],
      idDirection: 'asc' as const,
    };
    const paged = await pageForward(engine, cfg, 7);
    assert.deepEqual(paged, truth);
  });

  test('forward, mixed directions with explicit NULLS override', async () => {
    const truth = (
      await engine.run('SELECT id FROM t ORDER BY a DESC NULLS LAST, b ASC NULLS FIRST, id DESC', [])
    ).map((r) => r.id);
    const cfg = {
      columns: [
        { name: 'a' as const, direction: 'desc' as const, nulls: 'last' as const },
        { name: 'b' as const, direction: 'asc' as const, nulls: 'first' as const },
      ],
      idDirection: 'desc' as const,
    };
    const paged = await pageForward(engine, cfg, 5);
    assert.deepEqual(paged, truth);
  });

  test('backward paging from an interior cursor reconstructs the prefix in order', async () => {
    const truth = (await engine.run('SELECT * FROM t ORDER BY a DESC, id DESC', [])) as unknown as Row[];
    const splitIndex = 41;
    const anchor = truth[splitIndex]!;
    const expected = truth.slice(0, splitIndex).map((r) => r.id);

    const cfg = { columns: [{ name: 'a' as const, direction: 'desc' as const }], idDirection: 'desc' as const };
    const got = await pageBackward(engine, cfg, anchor, 6);
    assert.deepEqual(got, expected);
  });
});
