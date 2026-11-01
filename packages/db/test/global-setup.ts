import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { requireTestDatabaseUrl } from './db-guard';

// Applies the committed migrations (not `db push`) so the tests exercise the exact SQL that
// production will run. Guard first: `migrate deploy` must never touch a non-test database.
export default function setup(): void {
  const databaseUrl = requireTestDatabaseUrl(process.env['DATABASE_URL']);
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}
