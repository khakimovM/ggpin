import { describe, expect, it } from 'vitest';
import { DatabaseTimeZoneError, assertUtcTimeZone } from './database-timezone.js';
import type { Tx } from './ledger/index.js';

// Audit L1: the session's TimeZone must be UTC. `createPrismaClient` pins it; this check verifies it
// (the API's PrismaService calls it at the production boot).
describe('assertUtcTimeZone', () => {
  const tx = (tz: string | undefined) =>
    ({ $queryRaw: () => Promise.resolve(tz === undefined ? [] : [{ tz }]) }) as unknown as Tx;

  it('accepts UTC and Etc/UTC', async () => {
    await expect(assertUtcTimeZone(tx('UTC'))).resolves.toBeUndefined();
    await expect(assertUtcTimeZone(tx('Etc/UTC'))).resolves.toBeUndefined();
  });

  it('refuses any other zone with an error that names it, and refuses a session that reports none', async () => {
    for (const zone of ['Asia/Tashkent', 'GMT', 'Europe/London', '']) {
      const error: unknown = await assertUtcTimeZone(tx(zone)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, zone).toBeInstanceOf(DatabaseTimeZoneError);
      expect((error as DatabaseTimeZoneError).timeZone).toBe(zone);
      expect((error as Error).message).toContain('not UTC');
    }
    await expect(assertUtcTimeZone(tx(undefined))).rejects.toBeInstanceOf(DatabaseTimeZoneError);
  });
});
