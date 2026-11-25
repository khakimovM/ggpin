import { describe, expect, it } from 'vitest';
import { isDatabaseError, redactDatabaseError } from './index';

// The rarer shapes of a database error (column lists, no Postgres facts, odd causes, empty text):
// each is still rebuilt from names only. The common shapes are in db-errors.test.ts.

const NEEDLES = ['needle_user', 'needle-provider-ref'];
const leaks = (value: unknown): string[] => {
  const json = JSON.stringify(value);
  return NEEDLES.filter((needle) => json.includes(needle));
};

class PrismaClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrismaClientValidationError';
  }
}

class DriverAdapterError extends Error {
  constructor(cause: Record<string, unknown>) {
    super(String(cause.kind));
    this.name = 'DriverAdapterError';
    this.cause = cause;
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

describe('redactDatabaseError: the less common shapes', () => {
  it('column lists (meta.target, constraint.fields) are names and stay; other shapes are dropped', () => {
    const cause = {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint',
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['userId', 'idempotencyKey'] },
    };
    const error = new PrismaClientKnownRequestError('Unique constraint failed', 'P2002', {
      modelName: 'Order',
      target: ['userId', 'idempotencyKey'],
      table: 7,
      driverAdapterError: new DriverAdapterError(cause),
    });
    expect(redactDatabaseError(error).meta).toEqual({
      modelName: 'Order',
      target: ['userId', 'idempotencyKey'],
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          kind: 'UniqueConstraintViolation',
          originalCode: '23505',
          constraint: { fields: ['userId', 'idempotencyKey'] },
          message: 'duplicate key value violates unique constraint',
        },
      },
    });
    const odd = new DriverAdapterError({ ...cause, constraint: { fields: [1, 2] } });
    expect(redactDatabaseError(odd).cause).not.toHaveProperty('constraint');
    const mixed = new PrismaClientKnownRequestError('x', 'P2002', { target: ['a', 3] });
    expect(redactDatabaseError(mixed).meta).toEqual({});
  });

  it('a Prisma error without Postgres facts keeps its meta names only', () => {
    const error = new PrismaClientKnownRequestError('No record was found for an update.', 'P2025', {
      modelName: 'Order',
      cause: 'needle_user',
    });
    const out = redactDatabaseError(error);
    expect(out.meta).toEqual({ modelName: 'Order' });
    expect(leaks(out)).toEqual([]);
  });

  it('an adapter error whose cause is not an object keeps no facts', () => {
    const error = new DriverAdapterError({ kind: 'postgres' });
    error.cause = 'needle-provider-ref';
    const out = redactDatabaseError(error);
    expect(out).not.toHaveProperty('cause');
    expect(leaks(out)).toEqual([]);
  });

  it('an empty message and no stack: a blank headline and the type line only', () => {
    const error = new PrismaClientValidationError('');
    error.stack = undefined;
    expect(redactDatabaseError(error)).toMatchObject({
      message: '',
      stack: 'PrismaClientValidationError: ',
    });
  });

  it('a DatabaseError-named error without pg facts is not taken for one', () => {
    class DatabaseError extends Error {}
    expect(isDatabaseError(new DatabaseError('x'))).toBe(false);
    const severityOnly = Object.assign(new DatabaseError('x'), { severity: 'ERROR' });
    expect(isDatabaseError(severityOnly)).toBe(false);
  });
});
