import { describe, expect, it } from 'vitest';
import {
  NonProductionDatabaseError,
  assertProductionDatabase,
  createPrismaClient,
  devToolDatabaseRefusal,
  productionDatabaseRefusal,
  readDatabaseIdentity,
  type PrismaClient,
} from '../src/index';
import { db } from './client';
import { requireTestDatabaseUrl } from './db-guard';

// L-1 (D-52 r3) on real Postgres: the dev marker is a property of the database
// (pg_db_role_setting, setrole = 0), not of the session. A URL `options=-c ggpin.env=dev`, a
// PGOPTIONS or a session SET must neither add it nor hide it. Existing databases are never
// re-marked: each case gets its own throwaway `*_test` database, dropped in `finally`.
const base = new URL(requireTestDatabaseUrl(process.env['DATABASE_URL']));

function urlFor(name: string, options?: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  url.search = '';
  if (options !== undefined) url.searchParams.set('options', options);
  return url.toString();
}

async function withTempDatabase(
  label: string,
  run: (name: string, connect: (options?: string) => PrismaClient) => Promise<void>,
): Promise<void> {
  const name = `ggpin_identity_${label}_${process.pid}_test`;
  requireTestDatabaseUrl(urlFor(name));
  const clients: PrismaClient[] = [];
  await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  try {
    await run(name, (options) => {
      const client = createPrismaClient(urlFor(name, options));
      clients.push(client);
      return client;
    });
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

async function sessionValue(client: Pick<PrismaClient, '$queryRaw'>): Promise<string | null> {
  const rows = await client.$queryRaw<{ value: string | null }[]>`
    SELECT pg_catalog.current_setting('ggpin.env', true) AS "value"`;
  return rows[0]?.value ?? null;
}

describe('database identity on real Postgres (L-1, D-52 r3)', () => {
  it('pg_db_role_setting is readable by every role (PUBLIC), also a non-superuser one', async () => {
    const [grant] = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_catalog.has_table_privilege('public', 'pg_catalog.pg_db_role_setting', 'SELECT')
        AS "ok"`;
    expect(grant?.ok).toBe(true);
    await withTempDatabase('read', async (name, connect) => {
      await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET ggpin.env = 'dev'`);
      const client = connect();
      // The dev role is the compose superuser; read again as a built-in non-superuser role.
      const asPlainRole = await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE pg_signal_backend');
        return readDatabaseIdentity(tx);
      });
      expect(asPlainRole).toEqual({ name, marker: 'dev' });
      await expect(readDatabaseIdentity(client)).resolves.toEqual({ name, marker: 'dev' });
    });
  });

  it('unmarked database: URL options, a session SET and a role setting do not make the marker', async () => {
    await withTempDatabase('unmarked', async (name, connect) => {
      const viaOptions = connect('-c ggpin.env=dev');
      expect(await sessionValue(viaOptions)).toBe('dev');
      await expect(readDatabaseIdentity(viaOptions)).resolves.toEqual({ name, marker: null });

      const plain = connect();
      const inSession = await plain.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ggpin.env = 'dev'");
        return readDatabaseIdentity(tx);
      });
      expect(inSession).toEqual({ name, marker: null });

      // A role-in-database setting (setrole <> 0) is not the database marker either.
      await db.$executeRawUnsafe(
        `ALTER ROLE CURRENT_USER IN DATABASE "${name}" SET ggpin.env = 'dev'`,
      );
      const roleScoped = connect();
      expect(await sessionValue(roleScoped)).toBe('dev');
      const identity = await readDatabaseIdentity(roleScoped);
      expect(identity).toEqual({ name, marker: null });
      // Without the marker a dev tool is allowed only by the URL's own _test name.
      expect(devToolDatabaseRefusal(identity, 'ggpin')).not.toBeNull();
    });
  });

  it('marked database: emptying ggpin.env in the session still fails the production check', async () => {
    await withTempDatabase('marked', async (name, connect) => {
      await db.$executeRawUnsafe(`ALTER DATABASE "${name}" SET ggpin.env = 'dev'`);
      const viaOptions = connect('-c ggpin.env=');
      expect(await sessionValue(viaOptions)).toBe('');
      const identity = await readDatabaseIdentity(viaOptions);
      expect(identity).toEqual({ name, marker: 'dev' });
      expect(productionDatabaseRefusal(identity)).toMatch(/dev marker/);
      await expect(assertProductionDatabase(viaOptions)).rejects.toBeInstanceOf(
        NonProductionDatabaseError,
      );

      const plain = connect();
      const inSession = await plain.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ggpin.env = ''");
        expect(await sessionValue(tx)).toBe('');
        return readDatabaseIdentity(tx);
      });
      expect(inSession).toEqual({ name, marker: 'dev' });
    });
  });
});
