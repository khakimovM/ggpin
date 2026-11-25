type Source = Readonly<Record<string, string | undefined>>;

/**
 * Variables that would redirect or weaken an HTTPS request made with Node's own fetch/https: an
 * extra or the system CA store, OpenSSL's own CA file/dir or config (S7 audit N-3), a proxy taken
 * from the environment (NODE_TLS_REJECT_UNAUTHORIZED=0 is checked by value, below). Refused by the
 * Fragment recorder (fragment-record-env.ts) and by a worker with FULFILLMENT_DRY_RUN=false (S7
 * audit L-2: the Fragment session's cookies, and later its payment requests, travel over Node's
 * fetch).
 */
export const NETWORK_REFUSED_WHEN_SET = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'OPENSSL_CONF',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
] as const;

/**
 * Node flags with the same effect as the variables above (S7 audit N-3), refused in NODE_OPTIONS
 * and on the command line (process.execArgv) of a live worker. Only these: other NODE_OPTIONS
 * values (a heap size, …) are fine, and `--require` / `--import` are not refused either: whoever
 * controls the process environment can already run their own code in it. This list guards
 * against a misconfigured trust store or proxy, not against that attacker.
 */
export const NETWORK_FLAGS_REFUSED = ['--use-system-ca', '--use-openssl-ca', '--use-env-proxy'];

/** `--use_system_ca=1` -> `--use-system-ca`: Node reads `_` as `-` in option names. */
function flagName(token: string): string {
  const name = token.split('=')[0] ?? '';
  return name.startsWith('--') ? `--${name.slice(2).replace(/_/gu, '-')}` : name;
}

export const TLS_REJECT_VARIABLE = 'NODE_TLS_REJECT_UNAUTHORIZED';
export const TLS_OFF_REASON = 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns TLS checks off';

/** Every network-weakening variable that is set (both spellings), by name, never the value. */
export function networkEnvRefusals(source: Source): string[] {
  const refusals: string[] = [];
  if ((source[TLS_REJECT_VARIABLE] ?? '').trim() === '0') refusals.push(TLS_OFF_REASON);
  for (const name of NETWORK_REFUSED_WHEN_SET) {
    for (const spelling of [name, name.toLowerCase()]) {
      if ((source[spelling] ?? '').trim() !== '') refusals.push(`${spelling} is set`);
    }
  }
  return refusals;
}

/** Every refused flag found in NODE_OPTIONS or in `execArgv`, by flag name, never another value. */
export function networkFlagRefusals(source: Source, execArgv: readonly string[]): string[] {
  const options = (source['NODE_OPTIONS'] ?? '').split(/\s+/u).map(flagName);
  const argv = execArgv.map(flagName);
  const refusals: string[] = [];
  for (const flag of NETWORK_FLAGS_REFUSED) {
    if (options.includes(flag)) refusals.push(`NODE_OPTIONS ${flag} is set`);
    if (argv.includes(flag)) refusals.push(`node option ${flag} is set`);
  }
  return refusals;
}
