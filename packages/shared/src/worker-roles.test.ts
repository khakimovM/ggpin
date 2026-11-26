import { describe, expect, it } from 'vitest';
import { WORKER_ONLY_SECRETS } from './env-secrets';
import { BANKFEED_PROCESS_HEARTBEAT_KEY, WORKER_HEARTBEAT_KEY } from './health';
import { BANK_FEED_HEARTBEAT_KEY } from './wallet/cache-keys';
import {
  BANK_FEED_ROLE_SECRETS,
  FULFILLMENT_ROLE_SECRETS,
  WORKER_ROLES,
  workerRoleHeartbeatKeys,
  workerRoleSecretProblems,
} from './worker-roles';

const VALUE = 'S3cr3t-value-that-must-not-be-printed';
const sourceOf = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, VALUE]));

describe('worker role secret lists', () => {
  it('split WORKER_ONLY_SECRETS into two disjoint groups that cover it exactly', () => {
    const bankFeed = new Set<string>(BANK_FEED_ROLE_SECRETS);
    expect(FULFILLMENT_ROLE_SECRETS.filter((n) => bankFeed.has(n))).toEqual([]);
    expect([...BANK_FEED_ROLE_SECRETS, ...FULFILLMENT_ROLE_SECRETS].sort()).toEqual(
      [...WORKER_ONLY_SECRETS].sort(),
    );
  });

  it('names exactly the three roles', () => {
    expect(WORKER_ROLES).toEqual(['fulfillment', 'bankfeed', 'all']);
  });
});

describe('workerRoleSecretProblems', () => {
  it('lets all hold every worker secret (dev/test)', () => {
    expect(workerRoleSecretProblems('all', sourceOf(WORKER_ONLY_SECRETS))).toEqual([]);
  });

  it('refuses each bankfeed secret (and the api id) in fulfillment, naming it only', () => {
    for (const name of [
      ...BANK_FEED_ROLE_SECRETS,
      'BANK_FEED_API_ID',
      'BANK_FEED_NEW_TOKEN',
      'BANKFEED_API_HASH',
      'BANKFEED_SESSION',
      'TG_API_HASH',
      'MTPROTO_SESSION',
      'TELEGRAM_MTPROTO_KEY',
    ]) {
      const problems = workerRoleSecretProblems('fulfillment', { [name]: VALUE });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).toContain('bankfeed container');
      expect(problems[0]).not.toContain(VALUE);
    }
  });

  it('allows fulfillment its own secrets and the non-secret bank-feed knobs', () => {
    const own = sourceOf(FULFILLMENT_ROLE_SECRETS);
    const knobs = { BANK_FEED_MODE: 'off', BANK_FEED_HUMO_BOT_ID: '1', BANK_FEED_POLL_SEC: '20' };
    expect(workerRoleSecretProblems('fulfillment', { ...own, ...knobs })).toEqual([]);
  });

  it('refuses each fulfillment secret in bankfeed, by list and by name shape', () => {
    const names = [
      ...FULFILLMENT_ROLE_SECRETS,
      'FAZERCARDS_API_KEY',
      'TONCENTER_API_KEY',
      'SUPPLIER_PUBG_API_KEY',
      'STEL_SSID',
      'HOT_WALLET_PK',
      'MY_SEED_PHRASE',
      'BANK_FEED_MNEMONIC',
    ];
    for (const name of names) {
      const problems = workerRoleSecretProblems('bankfeed', { [name]: VALUE });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(name);
      expect(problems[0]).toContain('fulfillment container');
      expect(problems[0]).not.toContain(VALUE);
    }
  });

  it('allows bankfeed its own secrets and ignores blanks', () => {
    const own = sourceOf([...BANK_FEED_ROLE_SECRETS, 'BANK_FEED_API_ID']);
    expect(workerRoleSecretProblems('bankfeed', { ...own, TON_API_KEY: ' ' })).toEqual([]);
  });
});

describe('workerRoleHeartbeatKeys', () => {
  it('gives each role its own process key; all writes both', () => {
    expect(workerRoleHeartbeatKeys('fulfillment')).toEqual([WORKER_HEARTBEAT_KEY]);
    expect(workerRoleHeartbeatKeys('bankfeed')).toEqual([BANKFEED_PROCESS_HEARTBEAT_KEY]);
    expect(workerRoleHeartbeatKeys('all')).toEqual([
      WORKER_HEARTBEAT_KEY,
      BANKFEED_PROCESS_HEARTBEAT_KEY,
    ]);
  });

  it('keeps the bankfeed process key apart from the listener-round key', () => {
    expect(BANKFEED_PROCESS_HEARTBEAT_KEY).toBe('bankfeed:process-heartbeat');
    expect(
      new Set([WORKER_HEARTBEAT_KEY, BANKFEED_PROCESS_HEARTBEAT_KEY, BANK_FEED_HEARTBEAT_KEY]).size,
    ).toBe(3);
  });
});
