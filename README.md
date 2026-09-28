# keyset-sql

Keyset (seek) pagination for raw SQL: builds the `WHERE`/`ORDER BY` fragment, the parameters, and an opaque cursor. No ORM, no query builder.

```ts
import { keyset, encodeCursor, decodeCursor } from 'keyset-sql';

const columns = [
  { name: 'created_at', direction: 'desc' },
  { name: 'id', direction: 'desc', unique: true, notNull: true },
];

const { where, orderBy, params } = keyset({
  columns,
  cursor: cursorParam ? { after: decodeCursor(cursorParam) } : undefined,
  dialect: 'postgres',
});

const rows = await client.query(
  `SELECT * FROM posts ${where ? `WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT $${params.length + 1}`,
  [...params, pageSize],
);
const nextCursor = rows.length ? encodeCursor(rows[rows.length - 1]) : null;
```

## Why

A cursor on one column drops rows the moment two rows tie on it — a coarse timestamp, a status column, anything that repeats. `WHERE created_at > $1 LIMIT n` moves past the whole tied group on page 1, so every row after the first tie member vanishes silently, no error, no duplicate, just gone.

```
6 rows, 5 of them tied on created_at = 1000

naive cursor (created_at only), page size 2:
  visited ids: [1, 2, 6]  (3/6 rows — the rest tie away)

keyset-sql cursor (created_at, id), page size 2:
  visited ids: [1, 2, 3, 4, 5, 6]  (6/6 rows)
```

Measured: `node examples/tie-drop-demo.ts`, real output above, against `node:sqlite`.

Fixing it means adding a unique tiebreaker column and comparing the whole tuple `(created_at, id) > (v1, v2)`, with `NULLS FIRST`/`NULLS LAST` semantics honored per dialect. Every incumbent found for this is bound to one ORM or query builder — `typeorm-cursor-pagination`, `objection-keyset-pagination`, `drizzle-cursor`, assorted Mongoose plugins. None of them work against `pg`, `mysql2`, `better-sqlite3`, or `node:sqlite` directly.

## Installation

```sh
npm install keyset-sql
```

Node >= 20.6. No runtime dependencies.

## Usage

### First page

Omit `cursor`. `where` comes back as `''`.

```ts
const { where, orderBy, params } = keyset({ columns, dialect: 'postgres' });
// where === '', so skip the WHERE clause entirely
```

### Next page

Encode the last row of the previous page into a cursor and pass it back as `after`.

```ts
const cursor = encodeCursor(lastRow); // opaque string, safe to put in a URL
// ... later, on the next request ...
const { where, orderBy, params } = keyset({
  columns,
  cursor: { after: decodeCursor(cursor) },
  dialect: 'postgres',
});
```

### Previous page

Same shape, `before` instead of `after`. `reversed` comes back `true`: `orderBy` is flipped so `LIMIT` grabs the page nearest the cursor, and the fetched rows need reversing in application code to restore ascending order.

```ts
const { where, orderBy, params, reversed } = keyset({
  columns,
  cursor: { before: decodeCursor(cursor) },
  dialect: 'postgres',
});
// params can hold several values (one per compared column per OR arm), so the
// LIMIT placeholder comes after all of them.
const { rows } = await client.query(
  `SELECT * FROM posts WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1}`,
  [...params, pageSize],
);
if (reversed) rows.reverse();
```

### Tamper-evident cursors

Pass an `hmacKey` to sign the cursor. `decodeCursor` throws `CursorTamperError` if it was modified or signed with a different key.

```ts
const cursor = encodeCursor(row, { hmacKey: process.env.CURSOR_KEY });
const row2 = decodeCursor(cursor, { hmacKey: process.env.CURSOR_KEY }); // throws on mismatch
```

### The row-value optimization

Mark every column `notNull: true` (matching a real `NOT NULL` constraint) when directions all agree, to get `("created_at", "id") > ($1, $2)` instead of the expanded `OR` form. Get the assertion wrong and rows go missing — see Limitations.

## Reference

### `keyset(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `KeysetColumn[]` | — | Required. At least one; the last must be `unique: true`. |
| `cursor` | `{ after: Row } \| { before: Row }` | — | Omit for the first page. |
| `dialect` | `'postgres' \| 'mysql' \| 'sqlite'` | — | Required. |
| `placeholder` | `'numbered' \| 'question'` | `numbered` for postgres, `question` otherwise | Placeholder style. |
| `startIndex` | `number` | `1` | First placeholder number, for `numbered` style. |

Returns `{ where, orderBy, params, reversed }`. `where` and `orderBy` are bare fragments (no `WHERE`/`ORDER BY` keywords); `where` is `''` when `cursor` is omitted.

### `KeysetColumn`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Column, or `table.column`. Validated and quoted, never interpolated raw. |
| `direction` | `'asc' \| 'desc'` | — | |
| `nulls` | `'first' \| 'last'` | The dialect's own `ORDER BY` default for `direction` | Where NULLs sort. |
| `notNull` | `boolean` | `false` | Assert the column has a `NOT NULL` constraint. Drops the redundant `OR col IS NULL` arm; required on every column to unlock the row-value form. |
| `unique` | `boolean` | `false` | Required on the last column. |

### `encodeCursor(row, options?)` / `decodeCursor(cursor, options?)`

Opaque, versioned, base64url-encoded JSON. `row` values are `string \| number \| boolean \| null \| Date`; anything else throws `UnsupportedCursorValueError`. `options.hmacKey` (`string | Buffer`) signs/verifies with HMAC-SHA256 via `node:crypto`.

### Errors

All extend `KeysetError`.

- `NoColumnsError`, `MissingTiebreakerError`, `InvalidColumnNameError`, `MissingCursorValueError`
- `MalformedCursorError`, `UnsupportedCursorVersionError`, `UnsupportedCursorValueError`, `CursorTamperError`

## How it works

Two predicate forms, chosen automatically:

- **OR-chain** (default): `(c1 > v1) OR (c1 = v1 AND c2 > v2) OR (c1 = v1 AND c2 = v2 AND c3 > v3)`, direction-aware per column (`<` for `desc`), with `IS NULL`/`IS NOT NULL` arms added per column exactly where the resolved `nulls` placement requires them. Correct for any mix of directions, NULLs, and nullable columns.
- **Row-value form**: `(c1, c2, c3) > (v1, v2, v3)`, used only when every column agrees on direction and asserts `notNull`, on postgres and sqlite. SQL's row comparison returns NULL/unknown — not true — the instant any compared column is NULL, so it silently drops rows exactly like the bug this package exists to fix if a column can actually hold NULL; `notNull` is how the caller vouches that it can't.

`ORDER BY` NULLs placement uses each dialect's native `NULLS FIRST`/`NULLS LAST` syntax on postgres and sqlite. MySQL has no such syntax, so a non-default placement is emulated with a leading `(col IS NULL) ASC|DESC` sort key.

Backward (`before`) paging flips every column's direction and `nulls` placement, builds the same predicate against the flipped ordering, and reports `reversed: true` — the caller runs `LIMIT` against the flipped `ORDER BY` to land on the page nearest the cursor, then reverses the fetched rows.

## Limitations

- Set `notNull` only where a real `NOT NULL` constraint exists. It is trusted, not verified — a wrong assertion reproduces exactly the row-dropping bug this package exists to prevent.
- MySQL is not run against a real server in this package's tests (no in-process MySQL exists for Node); its NULL-ordering defaults and `NULLS`-emulation SQL are implemented from documented MySQL behavior, not verified live. Treat it as "not tested" — see Compatibility.
- Cursors are not encrypted, only optionally signed. A cursor without `hmacKey` can be decoded and inspected (though not usefully forged, since `keyset()` only reads the declared columns) by anyone holding it.
- `keyset()` returns SQL fragments; it does not run queries, manage connections, or know your driver's placeholder quirks beyond `numbered`/`question`.
- Column identifiers support plain names and one level of `table.column` qualification. No expressions, no computed columns.

## Compatibility

Tested in this repo, with `-count=1` on every run:

- **sqlite**: `node:sqlite` (`node:test`), Node 24.20.0.
- **postgres**: `@electric-sql/pglite` 0.5.8 (real Postgres compiled to WASM), no external server.
- **mysql**: not tested — no in-process MySQL engine for Node exists. `mysql` dialect output is exercised only by pure unit tests (no live query execution). NULL-ordering defaults for MySQL are implemented from documented behavior, unverified against a live server.

CI (`.github/workflows/test.yml`) additionally runs the built `dist/` smoke tests on Node 20.6 and 22 — "run in CI", not independently verified here.

## Development

```sh
npm install
node --test "test/*.test.ts"    # full suite, needs node 24+ for type stripping
node examples/tie-drop-demo.ts

npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

## License

MIT. See [LICENSE](./LICENSE).
