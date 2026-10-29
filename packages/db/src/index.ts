import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

/**
 * The only place a PrismaClient is built (rules/20-database-prisma.md). The URL is passed in by
 * the caller from its validated config, so this package never reads process.env at runtime.
 * pg connects lazily on the first query: constructing a client needs no running database.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
