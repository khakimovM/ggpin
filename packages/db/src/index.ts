import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';
export * from './ledger/index.js';
export * from './orders/index.js';
export { lockTopupCard } from './payments/card-lock.js';
export { cardTotals } from './payments/card-totals.js';
export type { CardTotals, CardTotalsQuery } from './payments/card-totals.js';
export { expireOverdueTopups } from './payments/topup-expire.js';
export type { TopupExpireScope } from './payments/topup-expire.js';
export { AUTO_CREDIT_HORIZON_MS } from './payments/auto-credit-horizon.js';
export { hasManualCredit, manualCreditsSince } from './payments/manual-credits.js';
export type { CreditSum, ManualCredits } from './payments/manual-credits.js';
export { usedTopupBaseSince } from './payments/topup-usage.js';
export {
  hasOpenSecurityPause,
  liveCardsWithoutSecurityPause,
  lockBankFeedPause,
  openSecurityPause,
} from './payments/security-pause.js';
export type { OpenSecurityPause } from './payments/security-pause.js';
export {
  DEV_DATABASE_MARKER,
  NonProductionDatabaseError,
  assertProductionDatabase,
  devToolDatabaseRefusal,
  markDevDatabase,
  productionDatabaseRefusal,
  readDatabaseIdentity,
} from './database-identity.js';
export type { DatabaseIdentity } from './database-identity.js';
export { DatabaseTimeZoneError, assertUtcTimeZone } from './database-timezone.js';

/** How long a query waits for a pooled connection before it fails. */
export const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * The only place a PrismaClient is built (rules/20-database-prisma.md). The URL is passed in by
 * the caller from its validated config, so this package never reads process.env at runtime.
 * pg connects lazily on the first query: constructing a client needs no running database.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      // pg's default is "wait forever" for a free connection. With the database down that
      // would hang every request (and /ready); fail fast instead.
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      // Every session speaks UTC (audit L1): the driver adapter reads a `timestamptz` without
      // converting its offset, so a session in Asia/Tashkent would shift clocks by hours. A startup
      // parameter beats the role's and the database's own TimeZone setting. `assertUtcTimeZone`
      // (production boot) verifies it, in case a URL option or a proxy overrode this.
      options: '-c TimeZone=UTC',
    }),
  });
}
