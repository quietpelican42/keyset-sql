import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MalformedCursorError,
  CursorTamperError,
  UnsupportedCursorVersionError,
  UnsupportedCursorValueError,
} from './errors.ts';

const CURSOR_VERSION = 1;

/** Wire encoding for a single value inside the cursor's JSON payload. */
type Wire = string | number | boolean | null | { __d: string };

export interface CursorOptions {
  /** When set, the cursor carries an HMAC-SHA256 tag and `decodeCursor` verifies it. */
  hmacKey?: string | Buffer;
}

function toWire(column: string, value: unknown): Wire {
  if (value instanceof Date) return { __d: value.toISOString() };
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new UnsupportedCursorValueError(column, value);
}

function fromWire(value: Wire): unknown {
  if (value !== null && typeof value === 'object' && '__d' in value) return new Date(value.__d);
  return value;
}

function sign(jsonPart: string, key: string | Buffer): string {
  return createHmac('sha256', key).update(jsonPart).digest('base64url');
}

/**
 * Encode a row (or partial row — just the keyset columns) into an opaque,
 * versioned cursor string. Pass the same row shape back to `keyset()` via
 * `cursor: { after: decodeCursor(str) }` (or `before`).
 *
 * Values must be `string | number | boolean | null | Date` — whatever a
 * driver hands back for the columns being paged on. Anything else throws.
 */
export function encodeCursor(row: Record<string, unknown>, opts: CursorOptions = {}): string {
  const d: Record<string, Wire> = {};
  for (const [key, value] of Object.entries(row)) d[key] = toWire(key, value);

  const jsonPart = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, d })).toString('base64url');
  return opts.hmacKey ? `${jsonPart}.${sign(jsonPart, opts.hmacKey)}` : jsonPart;
}

/**
 * Decode a cursor produced by `encodeCursor`. Throws `MalformedCursorError`
 * on garbage input, `UnsupportedCursorVersionError` on a cursor from an
 * incompatible future version, and `CursorTamperError` when `hmacKey` is
 * given and the signature doesn't match.
 */
export function decodeCursor(cursor: string, opts: CursorOptions = {}): Record<string, unknown> {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new MalformedCursorError('cursor is not a non-empty string');
  }
  const dot = cursor.indexOf('.');
  const jsonPart = dot === -1 ? cursor : cursor.slice(0, dot);
  const sigPart = dot === -1 ? undefined : cursor.slice(dot + 1);

  if (opts.hmacKey) {
    if (!sigPart) throw new CursorTamperError();
    const expected = Buffer.from(sign(jsonPart, opts.hmacKey));
    const actual = Buffer.from(sigPart);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new CursorTamperError();
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(jsonPart, 'base64url').toString('utf8'));
  } catch {
    throw new MalformedCursorError('payload is not valid base64url JSON');
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('v' in payload) ||
    !('d' in payload) ||
    typeof (payload as { d: unknown }).d !== 'object' ||
    (payload as { d: unknown }).d === null
  ) {
    throw new MalformedCursorError('payload is missing the expected {v, d} shape');
  }
  const { v, d } = payload as { v: unknown; d: Record<string, Wire> };
  if (v !== CURSOR_VERSION) throw new UnsupportedCursorVersionError(v);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(d)) out[key] = fromWire(value);
  return out;
}
