/**
 * Refuses to run against anything but a throwaway test database: these tests TRUNCATE every
 * table, so pointing them at `ggpin` would wipe the dev data (rules/70-testing.md).
 */
export function requireTestDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error('DATABASE_URL is not set; DB tests need a database whose name ends in _test.');
  }
  const name = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run DB tests: database "${name}" does not end in "_test".`);
  }
  return raw;
}
