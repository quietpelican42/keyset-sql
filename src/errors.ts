/** Base class for every error this library throws. */
export class KeysetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A column name failed identifier validation (not a plain `name` or `table.name`). */
export class InvalidColumnNameError extends KeysetError {
  column: string;
  constructor(column: string) {
    super(
      `Invalid column name "${column}" — expected an identifier or "table.column", ` +
        `matching /^[A-Za-z_][A-Za-z0-9_]*$/ per part`,
    );
    this.column = column;
  }
}

/** No column in `columns` was declared `unique: true`. Paging is unsafe without a tiebreaker. */
export class MissingTiebreakerError extends KeysetError {
  constructor() {
    super(
      'keyset() requires the last column to be declared `unique: true`. Without a unique ' +
        'tiebreaker, ties on the leading columns silently drop or duplicate rows across pages.',
    );
  }
}

/** `columns` was empty. */
export class NoColumnsError extends KeysetError {
  constructor() {
    super('keyset() requires at least one column');
  }
}

/** The cursor object is missing a value for a declared column. */
export class MissingCursorValueError extends KeysetError {
  column: string;
  constructor(column: string) {
    super(`Cursor is missing a value for column "${column}"`);
    this.column = column;
  }
}

/** `decodeCursor` was given a string that isn't a well-formed keyset-sql cursor. */
export class MalformedCursorError extends KeysetError {
  constructor(reason: string) {
    super(`Malformed cursor: ${reason}`);
  }
}

/** `decodeCursor` was given an HMAC key and the signature didn't match. */
export class CursorTamperError extends KeysetError {
  constructor() {
    super('Cursor signature does not match — it was modified or signed with a different key');
  }
}

/** A cursor's version isn't one this build of keyset-sql knows how to decode. */
export class UnsupportedCursorVersionError extends KeysetError {
  version: unknown;
  constructor(version: unknown) {
    super(`Cursor version ${JSON.stringify(version)} is not supported by this version of keyset-sql`);
    this.version = version;
  }
}

/** `encodeCursor` was given a row value that can't round-trip through JSON. */
export class UnsupportedCursorValueError extends KeysetError {
  column: string;
  constructor(column: string, value: unknown) {
    super(
      `Cannot encode column "${column}" into a cursor: value of type ${typeof value} is not ` +
        `a string, number, boolean, null, or Date`,
    );
    this.column = column;
  }
}
