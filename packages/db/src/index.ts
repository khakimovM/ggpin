import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

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
    }),
  });
}
