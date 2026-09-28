import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  keyset,
  encodeCursor,
  decodeCursor,
  MissingTiebreakerError,
  NoColumnsError,
  MissingCursorValueError,
  InvalidColumnNameError,
  MalformedCursorError,
  CursorTamperError,
  UnsupportedCursorVersionError,
  UnsupportedCursorValueError,
} from '../src/index.ts';

describe('validation', () => {
  test('throws when no columns are given', () => {
    assert.throws(() => keyset({ columns: [], dialect: 'postgres' }), NoColumnsError);
  });

  test('throws when the last column is not marked unique', () => {
    assert.throws(
      () => keyset({ columns: [{ name: 'created_at', direction: 'desc' }], dialect: 'postgres' }),
      MissingTiebreakerError,
    );
  });

  test('throws on an invalid column identifier', () => {
    assert.throws(
      () =>
        keyset({
          columns: [{ name: 'id; DROP TABLE users --', direction: 'asc', unique: true }],
          dialect: 'postgres',
        }),
      InvalidColumnNameError,
    );
  });

  test('accepts a qualified table.column identifier', () => {
    const { orderBy } = keyset({
      columns: [{ name: 'posts.id', direction: 'asc', unique: true }],
      dialect: 'postgres',
    });
    assert.equal(orderBy, '"posts"."id" ASC');
  });

  test('throws when the cursor is missing a value for a declared column', () => {
    assert.throws(
      () =>
        keyset({
          columns: [
            { name: 'created_at', direction: 'desc' },
            { name: 'id', direction: 'desc', unique: true },
          ],
          cursor: { after: { id: 5 } },
          dialect: 'postgres',
        }),
      MissingCursorValueError,
    );
  });
});

describe('no cursor (first page)', () => {
  test('where is empty and params is empty', () => {
    const result = keyset({
      columns: [{ name: 'id', direction: 'asc', unique: true }],
      dialect: 'postgres',
    });
    assert.equal(result.where, '');
    assert.deepEqual(result.params, []);
    assert.equal(result.reversed, false);
    assert.equal(result.orderBy, '"id" ASC');
  });
});

describe('single-column cursor', () => {
  test('forward, ascending, postgres placeholders', () => {
    const { where, orderBy, params } = keyset({
      columns: [{ name: 'id', direction: 'asc', unique: true, notNull: true }],
      cursor: { after: { id: 10 } },
      dialect: 'postgres',
    });
    assert.equal(where, '"id" > $1');
    assert.equal(orderBy, '"id" ASC');
    assert.deepEqual(params, [10]);
  });

  test('forward, descending, mysql backtick quoting and ? placeholders', () => {
    const { where, orderBy, params } = keyset({
      columns: [{ name: 'id', direction: 'desc', unique: true, notNull: true }],
      cursor: { after: { id: 10 } },
      dialect: 'mysql',
    });
    assert.equal(where, '`id` < ?');
    assert.equal(orderBy, '`id` DESC');
    assert.deepEqual(params, [10]);
  });

  test('startIndex offsets numbered placeholders', () => {
    const { where, params } = keyset({
      columns: [{ name: 'id', direction: 'asc', unique: true, notNull: true }],
      cursor: { after: { id: 10 } },
      dialect: 'postgres',
      startIndex: 5,
    });
    assert.equal(where, '"id" > $5');
    assert.deepEqual(params, [10]);
  });

  test('id left nullable (no notNull) grows a redundant but harmless OR IS NULL arm', () => {
    const { where } = keyset({
      columns: [{ name: 'id', direction: 'asc', unique: true }],
      cursor: { after: { id: 10 } },
      dialect: 'postgres',
    });
    // Postgres default for ASC is NULLS LAST; without asserting notNull,
    // keyset-sql can't assume id is never null, so it stays defensive.
    assert.equal(where, '("id" > $1 OR "id" IS NULL)');
  });
});

describe('composite cursor (OR-chain, the default without notNull)', () => {
  test('two ascending columns', () => {
    const { where, params } = keyset({
      columns: [
        { name: 'created_at', direction: 'asc' },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '("created_at" > $1 OR "created_at" IS NULL) OR ("created_at" = $2 AND "id" > $3)');
    assert.deepEqual(params, [100, 100, 5]);
  });

  test('mixed asc/desc directions', () => {
    const { where, orderBy } = keyset({
      columns: [
        { name: 'created_at', direction: 'desc', notNull: true },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(orderBy, '"created_at" DESC, "id" ASC');
    assert.equal(where, '"created_at" < $1 OR ("created_at" = $2 AND "id" > $3)');
  });
});

describe('row-value comparison (opt in via notNull)', () => {
  test('uses the tuple form when every column asserts notNull and directions agree', () => {
    const { where, params } = keyset({
      columns: [
        { name: 'created_at', direction: 'desc', notNull: true },
        { name: 'id', direction: 'desc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '("created_at", "id") < ($1, $2)');
    assert.deepEqual(params, [100, 5]);
  });

  test('falls back to the OR-chain when directions disagree, even with notNull', () => {
    const { where } = keyset({
      columns: [
        { name: 'created_at', direction: 'desc', notNull: true },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.match(where, /OR/);
  });

  test('falls back to the OR-chain when only some columns assert notNull', () => {
    const { where } = keyset({
      columns: [
        { name: 'created_at', direction: 'desc' },
        { name: 'id', direction: 'desc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.match(where, /OR/);
  });

  test('never used for mysql, even with notNull and agreeing directions', () => {
    const { where } = keyset({
      columns: [
        { name: 'created_at', direction: 'desc', notNull: true },
        { name: 'id', direction: 'desc', unique: true, notNull: true },
      ],
      cursor: { after: { created_at: 100, id: 5 } },
      dialect: 'mysql',
    });
    assert.doesNotMatch(where, /^\(/); // not the tuple form
    assert.match(where, /OR/);
  });
});

describe('null-aware predicates', () => {
  test('non-null cursor value, NULLS LAST column: adds an OR IS NULL arm', () => {
    const { where } = keyset({
      columns: [
        { name: 'a', direction: 'asc', nulls: 'last' },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { a: 1, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '("a" > $1 OR "a" IS NULL) OR ("a" = $2 AND "id" > $3)');
  });

  test('non-null cursor value, NULLS FIRST column: no OR IS NULL arm', () => {
    const { where } = keyset({
      columns: [
        { name: 'a', direction: 'asc', nulls: 'first' },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { a: 1, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '"a" > $1 OR ("a" = $2 AND "id" > $3)');
  });

  test('null cursor value, NULLS LAST column: nothing sorts after it (1=0)', () => {
    const { where, params } = keyset({
      columns: [
        { name: 'a', direction: 'asc', nulls: 'last' },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { a: null, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '1=0 OR ("a" IS NULL AND "id" > $1)');
    assert.deepEqual(params, [5]);
  });

  test('null cursor value, NULLS FIRST column: everything non-null sorts after it', () => {
    const { where, params } = keyset({
      columns: [
        { name: 'a', direction: 'asc', nulls: 'first' },
        { name: 'id', direction: 'asc', unique: true, notNull: true },
      ],
      cursor: { after: { a: null, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(where, '"a" IS NOT NULL OR ("a" IS NULL AND "id" > $1)');
    assert.deepEqual(params, [5]);
  });
});

describe('NULLS FIRST/LAST in ORDER BY', () => {
  test('postgres and sqlite emit NULLS FIRST/LAST directly when non-default', () => {
    const { orderBy } = keyset({
      columns: [{ name: 'a', direction: 'asc', nulls: 'first' }, { name: 'id', direction: 'asc', unique: true }],
      dialect: 'postgres',
    });
    assert.equal(orderBy, '"a" ASC NULLS FIRST, "id" ASC');
  });

  test('mysql emulates a non-default NULLS placement with an (IS NULL) sort key', () => {
    const { orderBy } = keyset({
      columns: [{ name: 'a', direction: 'asc', nulls: 'last' }, { name: 'id', direction: 'asc', unique: true }],
      dialect: 'mysql',
    });
    assert.equal(orderBy, '(`a` IS NULL) ASC, `a` ASC, `id` ASC');
  });

  test('mysql needs no emulation for its own default', () => {
    const { orderBy } = keyset({
      columns: [{ name: 'a', direction: 'asc' }, { name: 'id', direction: 'asc', unique: true }],
      dialect: 'mysql',
    });
    assert.equal(orderBy, '`a` ASC, `id` ASC');
  });
});

describe('backward paging', () => {
  test('flips direction, nulls, and reports reversed: true', () => {
    const result = keyset({
      columns: [
        { name: 'created_at', direction: 'desc' },
        { name: 'id', direction: 'desc', unique: true, notNull: true },
      ],
      cursor: { before: { created_at: 100, id: 5 } },
      dialect: 'postgres',
    });
    assert.equal(result.reversed, true);
    assert.equal(result.orderBy, '"created_at" ASC, "id" ASC');
    assert.equal(result.where, '("created_at" > $1 OR "created_at" IS NULL) OR ("created_at" = $2 AND "id" > $3)');
  });
});

describe('cursor encode/decode', () => {
  test('round-trips plain values', () => {
    const row = { id: 42, name: 'a"b\\c', flag: true, empty: null };
    assert.deepEqual(decodeCursor(encodeCursor(row)), row);
  });

  test('round-trips a Date', () => {
    const row = { createdAt: new Date('2024-01-02T03:04:05.678Z') };
    const decoded = decodeCursor(encodeCursor(row));
    assert.ok(decoded.createdAt instanceof Date);
    assert.equal((decoded.createdAt as Date).toISOString(), '2024-01-02T03:04:05.678Z');
  });

  test('is opaque base64url, not plain JSON', () => {
    const cursor = encodeCursor({ id: 1 });
    assert.doesNotMatch(cursor, /[{}":]/);
  });

  test('rejects garbage input', () => {
    assert.throws(() => decodeCursor('not-a-cursor!!'), MalformedCursorError);
    assert.throws(() => decodeCursor(''), MalformedCursorError);
  });

  test('rejects an unknown cursor version', () => {
    const forged = Buffer.from(JSON.stringify({ v: 99, d: { id: 1 } })).toString('base64url');
    assert.throws(() => decodeCursor(forged), UnsupportedCursorVersionError);
  });

  test('throws on a value that cannot round-trip through JSON', () => {
    assert.throws(() => encodeCursor({ id: 1n as unknown as number }), UnsupportedCursorValueError);
  });

  test('HMAC: verifies a matching key and round-trips', () => {
    const cursor = encodeCursor({ id: 1 }, { hmacKey: 'secret' });
    assert.deepEqual(decodeCursor(cursor, { hmacKey: 'secret' }), { id: 1 });
  });

  test('HMAC: rejects a tampered payload', () => {
    const cursor = encodeCursor({ id: 1 }, { hmacKey: 'secret' });
    const [json, sig] = cursor.split('.');
    const tamperedJson = Buffer.from(JSON.stringify({ v: 1, d: { id: 999 } })).toString('base64url');
    assert.throws(() => decodeCursor(`${tamperedJson}.${sig}`, { hmacKey: 'secret' }), CursorTamperError);
  });

  test('HMAC: rejects the wrong key', () => {
    const cursor = encodeCursor({ id: 1 }, { hmacKey: 'secret' });
    assert.throws(() => decodeCursor(cursor, { hmacKey: 'other' }), CursorTamperError);
  });

  test('HMAC: rejects a cursor with no signature when a key is required', () => {
    const cursor = encodeCursor({ id: 1 });
    assert.throws(() => decodeCursor(cursor, { hmacKey: 'secret' }), CursorTamperError);
  });
});
