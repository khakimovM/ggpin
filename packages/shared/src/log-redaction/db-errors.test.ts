import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isDatabaseError,
  redactDatabaseError,
  redactLogRecord,
  redactSecrets,
} from './index';

// The shapes Prisma 7 with @prisma/adapter-pg logged against the test database (phase 5 S2 audit
// L3): a validation error renders the call's `data`; a database refusal carries the Postgres facts
// under meta.driverAdapterError.cause, with `detail` holding the row or the key.

const NEEDLES = ['needle_user', 'NeedleName', 'needle-provider-ref', '123456789', 'needle-idem'];
const leaks = (value: unknown): string[] => {
  const json = JSON.stringify(value);
  return NEEDLES.filter((needle) => json.includes(needle));
};

const FRAMES = [
  '    at Xn.handleRequestError (C:\\repo\\node_modules\\@prisma\\client\\RequestHandler.ts:238:13)',
  '    at OrdersRepository.createPaid (C:\\repo\\orders.repository.ts:142:21)',
];
const CALL_LINE = 'Invalid `tx.order.create()` invocation in';
const CALL = [
  '',
  CALL_LINE,
  'C:\\repo\\orders.repository.ts:142:21',
  '',
  '→ 142   return tx.order.create({',
  '          data: {',
  '            quantity: "fifty",',
  '            recipient: { username: "needle_user", displayName: "NeedleName" },',
  '            providerRef: "needle-provider-ref",',
  '            costMinor: 123456789n,',
  '            idempotencyKey: "needle-idem"',
  '          }',
  '        })',
].join('\n');

class PrismaClientValidationError extends Error {
  readonly clientVersion = '7.10.1';
  constructor(message: string) {
    super(message);
    this.name = 'PrismaClientValidationError';
    this.stack = [`${this.name}: ${message}`, ...FRAMES].join('\n');
  }
}

class DriverAdapterError extends Error {
  constructor(cause: Record<string, unknown>) {
    super(typeof cause.message === 'string' ? cause.message : String(cause.kind));
    this.name = 'DriverAdapterError';
    this.cause = cause;
  }
}

class PrismaClientKnownRequestError extends Error {
  readonly clientVersion = '7.10.1';
  constructor(
    message: string,
    readonly code: string,
    readonly meta: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.stack = [`${this.name}: ${message}`, ...FRAMES].join('\n');
  }
}

/** A refusal of `tx.order.create()` as Prisma wraps it (P2039: an unmapped Postgres error). */
function refused(cause: Record<string, unknown>, code = 'P2039') {
  const pg = String(cause.originalMessage);
  const message = `${CALL}\nDatabase error. Code: \`${String(cause.originalCode)}\`. Message: \`${pg}\``;
  return new PrismaClientKnownRequestError(message, code, {
    modelName: 'Order',
    driverAdapterError: new DriverAdapterError(cause),
  });
}

const GUARD_TEXT = 'Order must equal its quote (user, product, price, no discount without a code)';
const CHECK_TEXT = 'new row for relation "Order" violates check constraint "Order_discount_check"';
const ROW = '(o1, 1, u1, {"username": "needle_user", "displayName": "NeedleName"}, 123456789)';
const postgres = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  originalCode: code,
  originalMessage: message,
  kind: 'postgres',
  code,
  severity: 'ERROR',
  message,
  ...extra,
});

describe('redactDatabaseError', () => {
  it('a validation error keeps the call and the frames, never the rendered data', () => {
    const out = redactDatabaseError(new PrismaClientValidationError(CALL));
    expect(out).toEqual({
      type: 'PrismaClientValidationError',
      name: 'PrismaClientValidationError',
      message: CALL_LINE,
      stack: [`PrismaClientValidationError: ${CALL_LINE}`, ...FRAMES].join('\n'),
      clientVersion: '7.10.1',
    });
  });

  it('a guard refusal (GG001) keeps its own text: it names the rule, not a value', () => {
    const out = redactDatabaseError(refused(postgres('GG001', GUARD_TEXT)));
    expect(out).toMatchObject({ code: 'P2039', clientVersion: '7.10.1', message: CALL_LINE });
    expect(out.meta).toEqual({
      modelName: 'Order',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          kind: 'postgres',
          originalCode: 'GG001',
          code: 'GG001',
          severity: 'ERROR',
          message: GUARD_TEXT,
        },
      },
    });
    expect(leaks(out)).toEqual([]);
  });

  it('a CHECK failure (23514) names the constraint; the failing row (detail) is dropped', () => {
    const cause = postgres('23514', CHECK_TEXT, {
      detail: `Failing row contains ${ROW}.`,
      hint: 'needle_user',
    });
    const out = redactDatabaseError(refused(cause));
    expect(out.meta).toMatchObject({
      driverAdapterError: { cause: { originalCode: '23514', message: CHECK_TEXT } },
    });
    expect(JSON.stringify(out)).not.toContain('Failing row');
    expect(leaks(out)).toEqual([]);
  });

  it('a unique violation (P2002) keeps the index and the table, not the key (detail)', () => {
    const cause = {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "Order_quoteId_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'Order_quoteId_key' },
      table: 'Order',
    };
    const out = redactDatabaseError(refused(cause, 'P2002'));
    expect(out.meta).toMatchObject({
      driverAdapterError: {
        cause: {
          kind: 'UniqueConstraintViolation',
          originalCode: '23505',
          constraint: { index: 'Order_quoteId_key' },
          table: 'Order',
        },
      },
    });
  });

  it('a class that quotes the value (22P02) loses its text, in the first line too', () => {
    const pg = 'invalid input syntax for type bigint: "needle-idem"';
    const cause = {
      originalCode: '22P02',
      originalMessage: pg,
      kind: 'InvalidInputValue',
      message: pg,
    };
    const error = new PrismaClientKnownRequestError(
      `Raw query failed. Code: \`22P02\`. Message: \`${pg}\``,
      'P2010',
      { driverAdapterError: new DriverAdapterError(cause) },
    );
    const out = redactDatabaseError(error);
    expect(out.message).toBe(`Raw query failed. Code: \`22P02\`. Message: \`${REDACTED}\``);
    expect(out.meta).toEqual({
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'InvalidInputValue', originalCode: '22P02' },
      },
    });
    expect(leaks(out)).toEqual([]);
    expect(leaks(redactDatabaseError(new DriverAdapterError(cause)))).toEqual([]);
  });

  it('a raw pg DatabaseError keeps the SQLSTATE and the names only', () => {
    class DatabaseError extends Error {
      readonly severity = 'ERROR';
      readonly code = '23505';
      readonly schema = 'public';
      readonly table = 'Order';
      readonly constraint = 'Order_userId_idempotencyKey_key';
      readonly detail = 'Key ("userId", "idempotencyKey")=(u1, needle-idem) already exists.';
      readonly where = 'needle_user';
      readonly internalQuery = 'needle-provider-ref';
      constructor() {
        super('duplicate key value violates unique constraint "Order_userId_idempotencyKey_key"');
        this.name = 'error';
      }
    }
    const out = redactDatabaseError(new DatabaseError());
    expect(out).toMatchObject({
      type: 'DatabaseError',
      code: '23505',
      severity: 'ERROR',
      table: 'Order',
      constraint: 'Order_userId_idempotencyKey_key',
    });
    expect(Object.keys(out)).not.toContain('detail');
    expect(leaks(out)).toEqual([]);
  });

  it('knows a database error by its name', () => {
    expect(isDatabaseError(new PrismaClientValidationError(CALL))).toBe(true);
    expect(isDatabaseError(new DriverAdapterError({ kind: 'postgres' }))).toBe(true);
    expect(isDatabaseError(new Error('x'))).toBe(false);
    expect(isDatabaseError(new TypeError('x'))).toBe(false);
  });
});

describe('a logger that opts in (databaseErrors: true)', () => {
  const options = { databaseErrors: true } as const;

  it('rebuilds a database error at any depth: as a cause, in an array, under any key', () => {
    const wrapped = new Error('purchase failed', { cause: new PrismaClientValidationError(CALL) });
    const out = redactSecrets(
      { err: wrapped, list: [refused(postgres('23514', CHECK_TEXT, { detail: ROW }))] },
      options,
    );
    expect(out).toMatchObject({
      err: { message: 'purchase failed', cause: { name: 'PrismaClientValidationError' } },
    });
    expect(leaks(out)).toEqual([]);
    const record = redactLogRecord(
      { error: new PrismaClientValidationError(CALL) },
      undefined,
      options,
    );
    expect(leaks(record)).toEqual([]);
  });

  it('without the option the copy is the old one (the worker opts in with its own wiring)', () => {
    expect(leaks(redactSecrets(new PrismaClientValidationError(CALL)))).not.toEqual([]);
  });
});
