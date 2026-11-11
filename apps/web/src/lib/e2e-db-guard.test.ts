import { describe, expect, it } from 'vitest';
import {
  checkE2eDatabaseUrl,
  maintenanceUrl,
  migrateOutputNamesDatabase,
} from '../../e2e/support/db-guard';

const url = (name: string) => `postgresql://ggpin:ggpin@localhost:5432/${name}`;
// The same URL on another host and port. Built by replacing the host, so the only credentials in
// this file stay those of the local docker-compose database on localhost (gitleaks allowlist).
const onHost = (host: string, port: string) =>
  url('ggpin_web_e2e_test').replace('@localhost:5432/', `@${host}:${port}/`);

describe('checkE2eDatabaseUrl', () => {
  it.each(['ggpin_web_e2e_test', 'ggpin_web_e2e_ci_test', 'x1_test'])('accepts %s', (name) => {
    expect(checkE2eDatabaseUrl(url(name))).toEqual({ url: url(name), name });
  });

  it.each([
    ['the database the backend suites clear', 'ggpin_test'],
    ['the same name, percent-encoded', 'ggpin%5Ftest'],
    ['the same name, encoded in other letters', '%67gpin_test'],
    ['a name that is not a test database', 'ggpin'],
    ['upper case', 'Ggpin_Web_test'],
    ['a name with a quote', 'a%22b_test'],
    ['a name with a percent sign left after decoding', 'a%25b_test'],
    ['a malformed escape', 'bad%E0%A4%A_test'],
    ['an empty name', ''],
    ['the maintenance database', 'postgres'],
  ])('refuses %s', (_label, name) => {
    expect(() => checkE2eDatabaseUrl(url(name))).toThrow();
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts the host %s (this machine)', (host) => {
    const local = onHost(host, '5433');
    expect(checkE2eDatabaseUrl(local).name).toBe('ggpin_web_e2e_test');
  });

  it.each(['db.example.com', '10.0.0.5', '192.0.2.1', 'localhost.evil.test', '[2001:db8::1]'])(
    'refuses the host %s: the journeys write there directly, so it must be this machine',
    (host) => {
      expect(() => checkE2eDatabaseUrl(onHost(host, '5432'))).toThrow('this machine');
    },
  );

  it('refuses a URL that is not postgres', () => {
    expect(() => checkE2eDatabaseUrl('http://localhost/x_test')).toThrow('postgresql');
    expect(() => checkE2eDatabaseUrl('not a url')).toThrow('valid URL');
  });
});

describe('maintenanceUrl', () => {
  it('keeps the server and credentials and points at postgres', () => {
    expect(maintenanceUrl(url('ggpin_web_e2e_test'))).toBe(
      'postgresql://ggpin:ggpin@localhost:5432/postgres',
    );
  });
});

describe('the 63-byte identifier limit', () => {
  // Postgres cuts a longer identifier silently, so a 64+ character name could reach a database
  // that no longer ends in _test. 58 characters + "_test" = 63 is the longest accepted.
  const named = (length: number) => 'a'.repeat(length - 5) + '_test';

  it('accepts a name of 63 characters, the longest Postgres keeps whole', () => {
    expect(named(63)).toHaveLength(63);
    expect(checkE2eDatabaseUrl(url(named(63))).name).toBe(named(63));
  });

  it.each([64, 65, 100])('refuses a name of %i characters', (length) => {
    expect(named(length)).toHaveLength(length);
    expect(() => checkE2eDatabaseUrl(url(named(length)))).toThrow();
  });

  it('refuses a 64-character name even when its cut form would still look like a test database', () => {
    const name = 'x'.repeat(58) + '_test_test';
    expect(name).toHaveLength(68);
    expect(() => checkE2eDatabaseUrl(url(name))).toThrow();
  });

  it('refuses just "_test" with nothing before it', () => {
    expect(() => checkE2eDatabaseUrl(url('_test'))).toThrow();
  });
});

describe('migrateOutputNamesDatabase', () => {
  // The line Prisma 7 printed in a real `migrate deploy` run (the host is the local docker one).
  const real = [
    'Loaded Prisma config from prisma.config.ts.',
    '',
    'Prisma schema loaded from prisma/schema.prisma.',
    'Datasource "db": PostgreSQL database "ggpin_web_e2e_ci_test", schema "public" at "localhost:5433"',
    '',
    '11 migrations found in prisma/migrations',
  ].join(String.fromCharCode(10));

  it('accepts the output that names the expected database', () => {
    expect(migrateOutputNamesDatabase(real, 'ggpin_web_e2e_ci_test')).toBe(true);
  });

  it('refuses output for another database, and output that names none', () => {
    expect(migrateOutputNamesDatabase(real, 'ggpin_test')).toBe(false);
    expect(migrateOutputNamesDatabase(real, 'ggpin_web_e2e')).toBe(false);
    expect(
      migrateOutputNamesDatabase('All migrations have been applied.', 'ggpin_web_e2e_ci_test'),
    ).toBe(false);
  });
});
