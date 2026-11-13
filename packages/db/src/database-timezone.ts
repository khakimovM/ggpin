import type { Tx } from './ledger/ledger.js';

/** The session's TimeZone is not UTC: `timestamp` columns (UTC, no zone) would be misread (audit L1). */
export class DatabaseTimeZoneError extends Error {
  constructor(readonly timeZone: string) {
    super(
      `the database session's TimeZone is "${timeZone}", not UTC: the clock rules of the payout path read ` +
        'zone-less UTC timestamps and would be wrong by the offset. createPrismaClient pins TimeZone=UTC ' +
        'in the connection options; a URL option or a proxy must not override it.',
    );
    this.name = 'DatabaseTimeZoneError';
  }
}

/** The session settings that name UTC. */
const UTC_NAMES: readonly string[] = ['UTC', 'Etc/UTC'];

/**
 * `SHOW TimeZone` of the current session, refused unless it is UTC (audit L1). Every `timestamp(3)`
 * column of ggpin holds UTC without a zone and the SQL guards convert with `timezone('UTC', now())`,
 * so they do not depend on the session; this check is for everything that reads a clock as a value
 * (and for the day a `timestamptz` is read by the driver). It runs at the production boot
 * (`assertProductionDatabase`), the one place that connects eagerly.
 */
export async function assertUtcTimeZone(db: Tx): Promise<void> {
  const rows = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS "tz"`;
  const tz = rows[0]?.tz;
  if (tz === undefined || !UTC_NAMES.includes(tz)) throw new DatabaseTimeZoneError(tz ?? '(none)');
}
