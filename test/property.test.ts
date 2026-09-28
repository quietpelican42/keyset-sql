/**
 * Property test: for many random table configurations (column order,
 * direction, NULLS placement) and many random tables (with heavy ties and
 * NULLs), paging through with keyset() at random page sizes must reproduce
 * exactly the same sequence as one plain ORDER BY query — forward and
 * backward, no dupes, no gaps.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';

import type { Engine, Row } from './helpers.ts';
import { mulberry32, randomTableConfig, randomRows, truthOrder, pageForward, pageBackward } from './helpers.ts';

const SQLITE_CONFIGS = 40;
const SQLITE_ROW_COUNTS = [10, 30, 80];

test(`sqlite: keyset paging matches ORDER BY across ${SQLITE_CONFIGS} configs x ${SQLITE_ROW_COUNTS.length} row counts`, async () => {
  let checked = 0;
  let totalRowsChecked = 0;

  for (let seed = 0; seed < SQLITE_CONFIGS; seed++) {
    for (const rowCount of SQLITE_ROW_COUNTS) {
      const rand = mulberry32(seed * 1000 + rowCount);
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)');
      const insert = db.prepare('INSERT INTO t (id, a, b) VALUES (?, ?, ?)');
      const rows = randomRows(rand, rowCount);
      for (const row of rows) insert.run(row.id, row.a, row.b);

      const engine: Engine = {
        dialect: 'sqlite',
        async run(sql, params) {
          return db.prepare(sql).all(...(params as never[])) as unknown as Row[];
        },
      };

      const cfg = randomTableConfig(rand);
      const truth = await truthOrder(engine, cfg);

      const pageSize = () => 1 + Math.floor(rand() * 6);
      const forward = await pageForward(engine, cfg, pageSize);
      assert.deepEqual(
        forward,
        truth,
        `forward mismatch: seed=${seed} rowCount=${rowCount} cfg=${JSON.stringify(cfg)}`,
      );
      assert.equal(new Set(forward).size, forward.length, `forward produced a duplicate: seed=${seed}`);

      if (truth.length > 1) {
        const splitIndex = 1 + Math.floor(rand() * (truth.length - 1));
        const anchorRows = (await engine.run('SELECT * FROM t WHERE id = ?', [
          truth[splitIndex],
        ])) as unknown as Row[];
        const backward = await pageBackward(engine, cfg, anchorRows[0]!, pageSize);
        assert.deepEqual(
          backward,
          truth.slice(0, splitIndex),
          `backward mismatch: seed=${seed} rowCount=${rowCount} cfg=${JSON.stringify(cfg)}`,
        );
      }

      checked++;
      totalRowsChecked += rowCount;
    }
  }

  console.log(`  property test (sqlite): ${checked} configurations, ${totalRowsChecked} total rows checked`);
  assert.equal(checked, SQLITE_CONFIGS * SQLITE_ROW_COUNTS.length);
});

// Smaller: pglite (WASM postgres) is much slower per query than node:sqlite.
// This exists to exercise postgres's own NULLS defaults (opposite of
// sqlite's) through the same property, not to repeat the full sweep.
const PG_CONFIGS = 8;
const PG_ROW_COUNT = 25;

test(`postgres (pglite): keyset paging matches ORDER BY across ${PG_CONFIGS} configs`, async () => {
  let checked = 0;

  for (let seed = 0; seed < PG_CONFIGS; seed++) {
    const rand = mulberry32(seed * 7 + 3);
    const db = new PGlite();
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)');
    const rows = randomRows(rand, PG_ROW_COUNT);
    for (const row of rows) {
      await db.query('INSERT INTO t (id, a, b) VALUES ($1, $2, $3)', [row.id, row.a, row.b]);
    }

    const engine: Engine = {
      dialect: 'postgres',
      async run(sql, params) {
        const res = await db.query(sql, params);
        return res.rows as unknown as Row[];
      },
    };

    const cfg = randomTableConfig(rand);
    const truth = await truthOrder(engine, cfg);

    const pageSize = () => 1 + Math.floor(rand() * 6);
    const forward = await pageForward(engine, cfg, pageSize);
    assert.deepEqual(forward, truth, `forward mismatch: seed=${seed} cfg=${JSON.stringify(cfg)}`);

    if (truth.length > 1) {
      const splitIndex = 1 + Math.floor(rand() * (truth.length - 1));
      const anchorRows = (await engine.run('SELECT * FROM t WHERE id = $1', [
        truth[splitIndex],
      ])) as unknown as Row[];
      const backward = await pageBackward(engine, cfg, anchorRows[0]!, pageSize);
      assert.deepEqual(backward, truth.slice(0, splitIndex), `backward mismatch: seed=${seed}`);
    }

    await db.close();
    checked++;
  }

  console.log(`  property test (postgres/pglite): ${checked} configurations, ${checked * PG_ROW_COUNT} total rows checked`);
  assert.equal(checked, PG_CONFIGS);
});
