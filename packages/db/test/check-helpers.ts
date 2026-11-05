import { expect } from 'vitest';

// CHECK violations are Postgres 23514; the driver message names the constraint.
export async function expectCheck(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `${constraint} must reject`).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(constraint);
}

async function rejection(promise: Promise<unknown>, what: string): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `${what} must reject`).toBeInstanceOf(Error);
  return error as Error;
}

/** A write refused by one of our triggers/guards: the SQLSTATE (default GG001) plus a message fragment. */
export async function expectGuard(
  promise: Promise<unknown>,
  fragment: string,
  sqlstate = 'GG001',
): Promise<void> {
  const error = await rejection(promise, fragment);
  expect(error.message).toContain(sqlstate);
  expect(error.message).toContain(fragment);
}

/** Prisma maps Postgres 23505 to P2002 and 23503 to P2003 (the unique / foreign-key tests). */
export async function expectPrismaCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await rejection(promise, code);
  expect((error as { code?: unknown }).code).toBe(code);
}
