import { describe, expect, it } from 'vitest';
import { MAX_LOGGED_ERROR_TEXT, describeErrorForLog } from './index';

// Review M1: the catch-all loggers of the API (Telegram outbox, bot, owner OTP) describe an error
// through describeErrorForLog, so a database error that reaches them never logs its data.

const NEEDLES = ['needle_user', 'NeedleName', 'needle-provider-ref', '123456789', 'needle-idem'];
const leaks = (line: string): string[] => NEEDLES.filter((needle) => line.includes(needle));

const CALL_LINE = 'Invalid `tx.order.create()` invocation in';
const RENDERED_CALL = [
  '',
  CALL_LINE,
  '',
  '→ 142   return tx.order.create({',
  '          data: {',
  '            recipient: { username: "needle_user", displayName: "NeedleName" },',
  '            providerRef: "needle-provider-ref",',
  '            costMinor: 123456789n,',
  '            idempotencyKey: "needle-idem"',
  '          }',
  '        })',
].join('\n');

class PrismaClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrismaClientValidationError';
  }
}

class PrismaClientKnownRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly meta: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}

class DriverAdapterError extends Error {
  constructor(cause: Record<string, unknown>) {
    super(String(cause.originalMessage));
    this.name = 'DriverAdapterError';
    this.cause = cause;
  }
}

/** A Postgres error of a class that quotes the value (22P02), as Prisma wraps it. */
function quotingRefusal(): Error {
  const pg = 'invalid input syntax for type bigint: "123456789"';
  const cause = { kind: 'postgres', originalCode: '22P02', originalMessage: pg };
  return new PrismaClientKnownRequestError(`Database error. Message: \`${pg}\``, 'P2010', {
    driverAdapterError: new DriverAdapterError(cause),
  });
}

describe('describeErrorForLog', () => {
  it('a Prisma validation error: its first line only, never the rendered call', () => {
    const line = describeErrorForLog(new PrismaClientValidationError(RENDERED_CALL));
    expect(line).toBe(`PrismaClientValidationError: ${CALL_LINE}`);
    expect(leaks(line)).toEqual([]);
  });

  it('a Postgres message that quotes a value is cut out', () => {
    const line = describeErrorForLog(quotingRefusal());
    expect(line.startsWith('PrismaClientKnownRequestError: ')).toBe(true);
    expect(leaks(line)).toEqual([]);
  });

  it('a wrapped Prisma error: the wrapper is named, its message (which repeats the data) is not', () => {
    const prisma = new PrismaClientValidationError(RENDERED_CALL);
    const wrapped = new Error(`send failed: ${prisma.message}`, { cause: prisma });
    const twice = new TypeError(`job failed: ${wrapped.message}`, { cause: wrapped });
    expect(describeErrorForLog(wrapped)).toBe(
      `Error caused by PrismaClientValidationError: ${CALL_LINE}`,
    );
    expect(describeErrorForLog(twice)).toBe(
      `TypeError caused by PrismaClientValidationError: ${CALL_LINE}`,
    );
    expect(leaks(describeErrorForLog(twice))).toEqual([]);
    expect(leaks(describeErrorForLog(new Error('x', { cause: quotingRefusal() })))).toEqual([]);
  });

  it('any other error: name and message, secrets scrubbed, cut to the limit', () => {
    expect(describeErrorForLog(new RangeError('queue is full'))).toBe('RangeError: queue is full');
    const url = describeErrorForLog(new Error('connect redis://:hunter2@cache:6379 failed'));
    expect(url).not.toContain('hunter2');
    expect(describeErrorForLog(new Error('x'.repeat(1000)))).toHaveLength(MAX_LOGGED_ERROR_TEXT);
    expect(describeErrorForLog(new Error('x'.repeat(1000)), 50)).toHaveLength(50);
    expect(describeErrorForLog(new PrismaClientValidationError(CALL_LINE), 10)).toHaveLength(10);
  });

  it('a cause that is not an Error ends the search; a chain of five plain errors is described', () => {
    expect(describeErrorForLog(new Error('plain', { cause: 'text' }))).toBe('Error: plain');
    let five: Error = new Error('root');
    for (let n = 0; n < 4; n += 1) five = new Error(`level ${String(n)}`, { cause: five });
    expect(describeErrorForLog(five)).toBe('Error: level 3');
  });

  it('a chain deeper than five: no message is copied, even when every wrapper repeats it', () => {
    let deep: Error = new PrismaClientValidationError(RENDERED_CALL);
    for (let n = 0; n < 5; n += 1) deep = new Error(`job: ${deep.message}`, { cause: deep });
    const line = describeErrorForLog(deep);
    expect(line).toBe('Error: cause chain too deep, message not logged');
    expect(leaks(line)).toEqual([]);
    let plain: Error = new Error('root');
    for (let n = 0; n < 5; n += 1) plain = new Error(`level ${String(n)}`, { cause: plain });
    expect(describeErrorForLog(plain)).toBe('Error: cause chain too deep, message not logged');
  });

  it('something that is not an Error', () => {
    for (const thrown of ['secret text', undefined, null, 42, { message: 'needle_user' }]) {
      expect(describeErrorForLog(thrown)).toBe('non-Error thrown');
    }
  });
});
