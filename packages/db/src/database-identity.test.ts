import { describe, expect, it, vi } from 'vitest';
import {
  NonProductionDatabaseError,
  assertProductionDatabase,
  devToolDatabaseRefusal,
  markDevDatabase,
  productionDatabaseRefusal,
  readDatabaseIdentity,
} from './database-identity.js';
import type { Tx } from './ledger/index.js';

// D-52 r2 (inject guard decision): a dev tool runs only on a *_test database (the one the URL
// names) or a database carrying the dev marker; a production process refuses both.
describe('database identity rules', () => {
  it('production refuses a _dev or _test name and the dev marker; a plain database passes', () => {
    expect(productionDatabaseRefusal({ name: 'ggpin', marker: null })).toBeNull();
    expect(productionDatabaseRefusal({ name: 'ggpin', marker: 'prod' })).toBeNull();
    for (const name of ['ggpin_test', 'ggpin_dev']) {
      expect(productionDatabaseRefusal({ name, marker: null })).toMatch(/_dev or _test/);
    }
    expect(productionDatabaseRefusal({ name: 'ggpin', marker: 'dev' })).toMatch(/dev marker/);
    // The marker is named first, so a marked _test database reports the marker (r3 e2e).
    expect(productionDatabaseRefusal({ name: 'ggpin_test', marker: 'dev' })).toMatch(/dev marker/);
  });

  it('a dev tool needs the marker, or the URL database itself ending with _test', () => {
    expect(devToolDatabaseRefusal({ name: 'ggpin', marker: 'dev' }, 'ggpin')).toBeNull();
    expect(devToolDatabaseRefusal({ name: 'ggpin_test', marker: null }, 'ggpin_test')).toBeNull();
    // A name alone is not enough: an SSH tunnel to production looks like localhost/ggpin.
    expect(devToolDatabaseRefusal({ name: 'ggpin', marker: null }, 'ggpin')).not.toBeNull();
    expect(devToolDatabaseRefusal({ name: 'ggpin_dev', marker: null }, 'ggpin_dev')).not.toBeNull();
    // The URL says _test but Postgres says otherwise (?dbname style options): refused.
    expect(devToolDatabaseRefusal({ name: 'ggpin', marker: null }, 'ggpin_test')).not.toBeNull();
  });

  it('reads the marker from pg_db_role_setting (database level), never current_setting', async () => {
    const sql: string[] = [];
    const tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        sql.push(strings.join('?'));
        return Promise.resolve([{ name: 'ggpin', marker: '' }]);
      }),
    } as unknown as Tx;
    await expect(readDatabaseIdentity(tx)).resolves.toEqual({ name: 'ggpin', marker: null });
    // L-1 (r3): a session value (`?options=-c ggpin.env=dev`, PGOPTIONS) must not count.
    expect(sql[0]).not.toContain('current_setting');
    expect(sql[0]).toContain('pg_catalog.pg_db_role_setting');
    expect(sql[0]).toContain('s.setrole OPERATOR(pg_catalog.=) 0');
    expect(sql[0]).toContain('pg_catalog.current_database()');
    expect(sql[0]).not.toMatch(/[^.]current_database\(\)/);
  });

  it('the seed marker is ALTER DATABASE on the connected database, no bound values', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const tx = {
      $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve(0);
      }),
    } as unknown as Tx;
    await markDevDatabase(tx);
    expect(calls[0]?.values).toEqual([]);
    expect(calls[0]?.sql).toContain(
      "format('ALTER DATABASE %I SET ggpin.env = %L', current_database(), 'dev')",
    );
  });
});

describe('assertProductionDatabase', () => {
  const tx = (name: string, marker: string | null) =>
    ({ $queryRaw: () => Promise.resolve([{ name, marker }]) }) as unknown as Tx;

  it('passes a plain database, throws NonProductionDatabaseError on _test, _dev or the marker', async () => {
    await expect(assertProductionDatabase(tx('ggpin', null))).resolves.toBeUndefined();
    for (const [name, marker] of [
      ['ggpin_test', null],
      ['ggpin_dev', null],
      ['ggpin', 'dev'],
    ] as const) {
      await expect(assertProductionDatabase(tx(name, marker))).rejects.toBeInstanceOf(
        NonProductionDatabaseError,
      );
    }
  });
});
