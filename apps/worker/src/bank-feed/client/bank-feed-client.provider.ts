import type { Provider } from '@nestjs/common';
import { BANK_FEED_DEFAULTS, BANK_FEED_LEADER_KEY, type BankFeedSource } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { RedisService } from '../../infra/redis/redis.service';
import { BankFeedNotifier } from '../bank-feed-notifier';
import { AuthorizationsWatch } from './authorizations-watch';
import { AutoCreditPauser } from './auto-credit-pauser';
import { BankChatAnomalyGuard } from './bank-chat-anomaly';
import { BankFeedAccountRepository } from './bank-feed-account.repository';
import { BANK_FEED_CLIENT, type BankFeedListenerClient } from './bank-feed-client';
import { BankFeedListener } from './bank-feed-listener';
import { BankFeedPoller } from './bank-feed-poller';
import { FakeBankFeedClient } from './fake-bank-feed.client';
import { RedisBankFeedBeat } from './heartbeat';
import { IngestService } from './ingest.service';
import { LeaderLock, RedisLockStore } from './leader-lock';
import { ListenerRepository } from './listener.repository';
import { MtcuteBankFeedClient } from './mtcute-bank-feed.client';
import { adaptTelegram, createTelegram, loadMtcute, type MtcuteModule } from './mtcute-loader';
import { decryptSession, parseSessionKey } from './session-crypto';

export const BANK_FEED_LISTENER = Symbol('BANK_FEED_LISTENER');
/** How often the leader lock is renewed (docs/05 §4: TTL 30 s, renewed every 10 s). */
export const LEADER_RENEW_MS = 10_000;
/** live: no healthy round for this long raises `listenerDown` (D-52, review I3). */
export const LISTENER_WATCHDOG_MS = 5 * 60_000;

/** A live-mode setting that must exist (loadEnv already refused a live config without it). */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required with BANK_FEED_MODE=live`);
  return value;
}

/**
 * The client of BANK_FEED_MODE: off -> null (no listener; the re-scan says `unavailable`),
 * fake -> in-memory, live -> mtcute. Only `live` loads @mtcute/node (and with it the native
 * better-sqlite3): `load` is never called for off and fake.
 */
export async function createBankFeedClient(
  config: WorkerConfig,
  load: () => Promise<MtcuteModule> = loadMtcute,
): Promise<BankFeedListenerClient | null> {
  if (config.BANK_FEED_MODE === 'off') return null;
  if (config.BANK_FEED_MODE === 'fake') return new FakeBankFeedClient();
  const bots: Record<BankFeedSource, bigint> = {
    HUMO_BOT: required(config.BANK_FEED_HUMO_BOT_ID, 'BANK_FEED_HUMO_BOT_ID'),
    UZCARD_BOT: required(config.BANK_FEED_UZCARD_BOT_ID, 'BANK_FEED_UZCARD_BOT_ID'),
  };
  const blob = required(config.BANK_FEED_SESSION_ENC, 'BANK_FEED_SESSION_ENC');
  const keyText = required(config.BANK_FEED_ENC_KEY, 'BANK_FEED_ENC_KEY');
  const telegram = createTelegram(await load(), {
    apiId: required(config.BANK_FEED_API_ID, 'BANK_FEED_API_ID'),
    apiHash: required(config.BANK_FEED_API_HASH, 'BANK_FEED_API_HASH'),
  });
  return new MtcuteBankFeedClient(adaptTelegram(telegram), {
    bots,
    // Opened at each start, in memory; the plaintext is not kept on the client.
    openSession: () => decryptSession(blob, parseSessionKey(keyText)),
  });
}

export const bankFeedClientProvider: Provider = {
  provide: BANK_FEED_CLIENT,
  inject: [WORKER_CONFIG],
  useFactory: (config: WorkerConfig) => createBankFeedClient(config),
};

/** The listener, or null when the mode is off (or a test replaced the client with null). */
export const bankFeedListenerProvider: Provider = {
  provide: BANK_FEED_LISTENER,
  inject: [
    WORKER_CONFIG,
    BANK_FEED_CLIENT,
    IngestService,
    ListenerRepository,
    AutoCreditPauser,
    RedisService,
    BankFeedNotifier,
    BankFeedAccountRepository,
    BankChatAnomalyGuard,
  ],
  useFactory: (
    config: WorkerConfig,
    client: BankFeedListenerClient | null,
    ingest: IngestService,
    messages: ListenerRepository,
    pauser: AutoCreditPauser,
    redis: RedisService,
    notifier: BankFeedNotifier,
    accounts: BankFeedAccountRepository,
    anomaly: BankChatAnomalyGuard,
  ): BankFeedListener | null => {
    if (config.BANK_FEED_MODE === 'off' || client === null) return null;
    return new BankFeedListener({
      client,
      poller: new BankFeedPoller(client, ingest, messages),
      lock: new LeaderLock(
        new RedisLockStore(redis.client),
        BANK_FEED_LEADER_KEY,
        BANK_FEED_DEFAULTS.LEADER_LOCK_TTL_SEC * 1000,
      ),
      beat: new RedisBankFeedBeat(redis.client),
      authorizations: new AuthorizationsWatch(accounts, pauser, notifier),
      account: accounts,
      messages,
      anomaly,
      pinnedBot: (source) => ingest.pinnedBot(source),
      notifier,
      timing: {
        pollMs: config.BANK_FEED_POLL_SEC * 1000,
        lockMs: LEADER_RENEW_MS,
        watchdogMs: config.BANK_FEED_MODE === 'live' ? LISTENER_WATCHDOG_MS : null,
      },
    });
  },
};
