import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// D-76 (CR #3): the frozen config of one role still carries the other side's non-secret settings
// with their parsed (unchecked) defaults (env.ts says why they stay typed as present). This guard
// makes that harmless: no source file of one side names a setting of the other, so an unchecked
// default can never steer that side's behaviour.

const SRC = join(__dirname, '..');

/** Value-out code: the fulfillment modules' directories. */
const FULFILLMENT_DIRS = ['ton', 'fulfillment', 'adapters', 'recipients', 'pricing-sync'];
const FULFILLMENT_EXTRA_DIRS = ['reconcile/orders'];
/** bank-feed/ helpers the fulfillment side imports as classes (not BankFeedModule). */
const SHARED_HELPERS = [
  'bank-feed/prisma-errors.ts',
  'bank-feed/client/leader-lock.ts',
  'bank-feed/wallet-cache-invalidator.ts',
];
/** Value-in code: the bank-feed and payment-reconcile directories (not reconcile/orders). */
const BANKFEED_DIRS = ['bank-feed', 'reconcile'];

/**
 * CR #2: each side's own env helpers in config/ (the runtime loaders and the side's CLI loaders).
 * The rest of config/ reads both sides on purpose (env.ts, worker-role.ts) or neither
 * (SHARED_CONFIG); the last test makes sure a new helper is put in one of the three lists.
 */
const FULFILLMENT_CONFIG = [
  'ton-env.ts',
  'ton-env-live.ts',
  'ton-api-key.ts',
  'ton-cli-env.ts',
  'wallet-secret.ts',
  'fragment-session-env.ts',
  'fragment-import-env.ts',
  'fragment-record-env.ts',
  'order-reconcile-env.ts',
  'simulated-payee.ts',
  'network-env.ts',
].map((f) => `config/${f}`);
const BANKFEED_CONFIG = ['bank-feed-env.ts', 'bank-feed-login-env.ts', 'topup-env.ts'].map(
  (f) => `config/${f}`,
);
const SHARED_CONFIG = [
  'env.ts',
  'worker-role.ts',
  'config.module.ts',
  'env-security.ts',
  'healthcheck-env.ts',
  'inject-guard.ts',
  'secret-file.ts',
].map((f) => `config/${f}`);

const BANKFEED_SETTINGS = /\b(TOPUP_[A-Z_]+|BANK_TIME_SKEW_SEC|BANK_FEED_[A-Z_]+)\b/g;
const FULFILLMENT_SETTINGS =
  /\b(TON_[A-Z_]+|FRAGMENT_[A-Z_]+|SUPPLIER_MAX_PER_ORDER_MICRO_USDT|PRICE_TOLERANCE_BPS|FULFILLMENT_DRY_RUN|ORDER_RECONCILE_EVERY_MS|HELD_MAX_AGE_MS|RESELLER_[A-Z_]+)\b/g;

function sources(dir: string, skip: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && !skip.includes(rel(path))) found.push(...sources(path, skip));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** The code without comments, so a comment that names a setting is no finding. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function rel(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

function findings(files: readonly string[], names: RegExp): string[] {
  return files.flatMap((path) =>
    [...code(path).matchAll(names)].map((match) => `${rel(path)}: ${match[0]}`),
  );
}

describe('role settings stay on their side', () => {
  it('fulfillment code never names a bankfeed setting', () => {
    const files = [
      ...[...FULFILLMENT_DIRS, ...FULFILLMENT_EXTRA_DIRS].flatMap((d) => sources(join(SRC, d))),
      ...SHARED_HELPERS.map((f) => join(SRC, f)),
      ...FULFILLMENT_CONFIG.map((f) => join(SRC, f)),
    ];
    expect(files.length).toBeGreaterThan(50);
    expect(findings(files, BANKFEED_SETTINGS)).toEqual([]);
  });

  it('bankfeed code never names a fulfillment setting', () => {
    const files = [
      ...BANKFEED_DIRS.flatMap((d) => sources(join(SRC, d), ['reconcile/orders'])),
      ...BANKFEED_CONFIG.map((f) => join(SRC, f)),
    ];
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => rel(f).startsWith('reconcile/orders/'))).toBe(false);
    expect(findings(files, FULFILLMENT_SETTINGS)).toEqual([]);
  });

  it('every config/ source is assigned to a side or to the shared list (CR #2)', () => {
    const listed = [...FULFILLMENT_CONFIG, ...BANKFEED_CONFIG, ...SHARED_CONFIG].sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(sources(join(SRC, 'config')).map(rel).sort()).toEqual(listed);
  });

  it('the patterns do find a setting (the guard is not vacuous)', () => {
    expect(findings([join(SRC, 'config/topup-env.ts')], BANKFEED_SETTINGS).length).toBeGreaterThan(
      0,
    );
    expect(findings([join(SRC, 'config/ton-env.ts')], FULFILLMENT_SETTINGS).length).toBeGreaterThan(
      0,
    );
  });
});
