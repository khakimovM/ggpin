// CLI-only config (prisma generate / validate / migrate). The runtime client never reads
// process.env: apps pass their validated DATABASE_URL to createPrismaClient().
import { defineConfig } from 'prisma/config';

try {
  // Optional local overrides for CLI commands; absent in CI and fresh clones.
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const databaseUrl = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` and `validate` need no database, so the url is only set when provided;
  // migrate commands fail with Prisma's own "datasource url missing" message otherwise.
  datasource: databaseUrl ? { url: databaseUrl } : undefined,
});
