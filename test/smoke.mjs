/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { keyset, encodeCursor, decodeCursor, MissingTiebreakerError, CursorTamperError } = await import(
  '../dist/index.js'
);

test('builds a first-page query with no cursor', () => {
  const { where, orderBy, params, reversed } = keyset({
    columns: [
      { name: 'created_at', direction: 'desc' },
      { name: 'id', direction: 'desc', unique: true, notNull: true },
    ],
    dialect: 'postgres',
  });
  assert.equal(where, '');
  assert.equal(orderBy, '"created_at" DESC, "id" DESC');
  assert.deepEqual(params, []);
  assert.equal(reversed, false);
});

test('builds a next-page query from a cursor', () => {
  const { where, params } = keyset({
    columns: [
      { name: 'created_at', direction: 'desc' },
      { name: 'id', direction: 'desc', unique: true, notNull: true },
    ],
    cursor: { after: { created_at: 100, id: 5 } },
    dialect: 'mysql',
  });
  assert.equal(where, '(`created_at` < ? OR `created_at` IS NULL) OR (`created_at` = ? AND `id` < ?)');
  assert.deepEqual(params, [100, 100, 5]);
});

test('throws without a unique tiebreaker', () => {
  assert.throws(() => keyset({ columns: [{ name: 'id', direction: 'asc' }], dialect: 'sqlite' }), MissingTiebreakerError);
});

test('cursor round-trips, including tamper detection', () => {
  const cursor = encodeCursor({ id: 42, at: new Date('2024-01-01T00:00:00.000Z') }, { hmacKey: 'k' });
  const decoded = decodeCursor(cursor, { hmacKey: 'k' });
  assert.equal(decoded.id, 42);
  assert.equal(decoded.at.toISOString(), '2024-01-01T00:00:00.000Z');
  assert.throws(() => decodeCursor(cursor, { hmacKey: 'wrong' }), CursorTamperError);
});
