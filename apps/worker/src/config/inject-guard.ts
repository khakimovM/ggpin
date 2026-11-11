import { devToolDatabaseRefusal, type DatabaseIdentity } from '@repo/db';

/** Variables that only a real (live) bank-feed setup has: their presence means "not a dev box". */
const LIVE_ONLY = [
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_API_HASH',
  'BANK_FEED_ENC_KEY_FILE',
] as const;

type Source = Readonly<Record<string, string | undefined>>;

export type InjectPrecheck =
  { readonly refusal: string } | { readonly refusal: null; readonly urlDatabase: string };

/**
 * The first half of the `bank-feed-inject` guard (D-52 r2, owner decision via the lead), before
 * anything connects: refused when any live bank-feed setting is present, DATABASE_URL is not a
 * URL, or session options are given (a URL `options` parameter or PGOPTIONS). The URL's database name is kept for the second half, `injectDatabaseRefusal`, which runs
 * AFTER connecting on what Postgres itself reports: the tool writes a synthetic bank notification
 * as if the bot had sent it, so a name in a URL (an SSH tunnel to production looks like
 * localhost/ggpin) is never enough. BANK_FEED_MODE=fake is checked separately (and refused in
 * production by loadEnv), and the tool is not in the production image (Dockerfile). Reasons name
 * variables, never values; the URL is not echoed. It lives in config/ because it reads the
 * process environment (before loadProcessEnv drops the key).
 */
export function injectPrecheck(source: Source = process.env): InjectPrecheck {
  const present = LIVE_ONLY.filter((name) => (source[name] ?? '').trim() !== '');
  if (present.length > 0) {
    return { refusal: `live bank-feed settings are set (${present.join(', ')})` };
  }
  // L-1 (r3): pg turns a URL `options` parameter and PGOPTIONS into session settings
  // (`-c ggpin.env=dev`, `-c search_path=...`). The marker is read from the database itself, but
  // a dev tool has no reason to carry either, so both are refused outright.
  if ((source.PGOPTIONS ?? '').trim() !== '') {
    return { refusal: 'PGOPTIONS is set: session options are not allowed for this tool' };
  }
  let url: URL;
  try {
    url = new URL(source.DATABASE_URL ?? '');
  } catch {
    return { refusal: 'DATABASE_URL is not a valid URL' };
  }
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === 'options')) {
    return { refusal: 'DATABASE_URL has an options parameter: session options are not allowed' };
  }
  return { refusal: null, urlDatabase: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}

/**
 * The second half, after connecting (`readDatabaseIdentity`: `pg_catalog.current_database()` and
 * the database-level `ggpin.env` from `pg_catalog.pg_db_role_setting`, never the session value):
 * allowed only on the URL's own `_test` database or a database marked dev (`ggpin.env = dev`, set
 * by `db:seed` with NODE_ENV=development|test and by the compose init script). Null: allowed.
 */
export function injectDatabaseRefusal(
  identity: DatabaseIdentity,
  urlDatabase: string,
): string | null {
  return devToolDatabaseRefusal(identity, urlDatabase);
}
