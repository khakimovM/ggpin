// The worker image runs as two containers with disjoint secrets (D-73 (6), D-76): `fulfillment`
// sends value out (TON wallet, Fragment, suppliers) and `bankfeed` takes value in (the bank-feed
// Telegram session, the P2P matcher). `all` is both in one process, for dev and tests only.
// Names, never values; nothing here reads `process.env`.
import { isBlank, isWalletMaterialName, isWorkerOnlySecretName } from './env-secrets';
import { BANKFEED_PROCESS_HEARTBEAT_KEY, WORKER_HEARTBEAT_KEY } from './health';

export const WORKER_ROLES = ['fulfillment', 'bankfeed', 'all'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The bankfeed container's secrets: the bank-feed Telegram user session and its key. */
export const BANK_FEED_ROLE_SECRETS = [
  'BANK_FEED_API_HASH',
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_ENC_KEY',
  'BANK_FEED_ENC_KEY_FILE',
] as const;

/** The fulfillment container's secrets: the hot wallet, the TON API, Fragment, the reseller. */
export const FULFILLMENT_ROLE_SECRETS = [
  'TON_MNEMONIC_ENC',
  'WALLET_ENC_KEY',
  'WALLET_ENC_KEY_FILE',
  'TON_API_KEY',
  'FRAGMENT_SESSION_ENC_KEY',
  'FRAGMENT_SESSION_ENC_KEY_FILE',
  'RESELLER_STARS_API_KEY',
] as const;

/**
 * Not a secret, but it names the bank-feed Telegram app: it belongs to the bankfeed container only,
 * so a fulfillment env that carries it was copied from the wrong template.
 */
const BANK_FEED_ROLE_IDENTIFIERS = ['BANK_FEED_API_ID'] as const;

const BANK_FEED_PREFIX = 'BANK_FEED_';

/**
 * MTProto session material under any name (SA F-4 (b)): an api_hash (TG_API_HASH), an MTProto
 * session (MTPROTO_SESSION) or a bank-feed key/session/hash spelt without the underscore
 * (BANKFEED_API_HASH). None of the fulfillment container's own names has this shape (a test reads
 * apps/worker/.env.example to keep it so): its keys say API_KEY, never API_HASH, and its only
 * SESSION names are FRAGMENT_*.
 */
const MTPROTO_SHAPED = /API_HASH|MTPROTO|BANK_?FEED.*(SESSION|KEY|HASH)/;

type Source = Readonly<Record<string, string | undefined>>;

/** The variable names only the other role may hold. */
function belongsElsewhere(role: Exclude<WorkerRole, 'all'>, name: string): boolean {
  const upper = name.toUpperCase();
  const bankFeedName = upper.startsWith(BANK_FEED_PREFIX);
  if (role === 'fulfillment') {
    return (
      (BANK_FEED_ROLE_SECRETS as readonly string[]).includes(upper) ||
      (BANK_FEED_ROLE_IDENTIFIERS as readonly string[]).includes(upper) ||
      (bankFeedName && isWorkerOnlySecretName(upper)) ||
      MTPROTO_SHAPED.test(upper)
    );
  }
  // bankfeed: every worker secret except its own BANK_FEED_* ones, by list AND by name shape (a
  // new supplier key forgotten in the lists is still refused); wallet material under any name.
  return (
    (FULFILLMENT_ROLE_SECRETS as readonly string[]).includes(upper) ||
    isWalletMaterialName(upper) ||
    (!bankFeedName && isWorkerOnlySecretName(upper))
  );
}

/**
 * Worker boot: one problem per set variable that belongs to the other role's container. `all`
 * holds both (dev/test). Messages name the variable, never its value.
 */
export function workerRoleSecretProblems(role: WorkerRole, source: Source): string[] {
  if (role === 'all') return [];
  const owner = role === 'fulfillment' ? 'bankfeed' : 'fulfillment';
  return Object.keys(source)
    .filter((name) => !isBlank(source[name]) && belongsElsewhere(role, name))
    .map(
      (name) =>
        `${name}: belongs to the ${owner} container and must not be set with WORKER_ROLE=${role} (remove it)`,
    );
}

/** The process heartbeat key(s) a worker of this role writes and its HEALTHCHECK reads. */
export function workerRoleHeartbeatKeys(role: WorkerRole): readonly string[] {
  if (role === 'fulfillment') return [WORKER_HEARTBEAT_KEY];
  if (role === 'bankfeed') return [BANKFEED_PROCESS_HEARTBEAT_KEY];
  return [WORKER_HEARTBEAT_KEY, BANKFEED_PROCESS_HEARTBEAT_KEY];
}
