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
