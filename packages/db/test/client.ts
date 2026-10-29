import { createPrismaClient } from '../src/index';
import { requireTestDatabaseUrl } from './db-guard';

export const db = createPrismaClient(requireTestDatabaseUrl(process.env['DATABASE_URL']));

export async function disconnect(): Promise<void> {
  await db.$disconnect();
}
