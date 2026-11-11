// ESM types: the module is loaded with import() (see loadMtcute), so its .d.ts, not the .d.cts.
import type * as Mtcute from '@mtcute/node' with { 'resolution-mode': 'import' };
import type { MtLoginTelegram, MtTelegram } from './mtcute-types';

export type MtcuteModule = typeof Mtcute;

/** mtcute's LogManager.OFF. At INFO it logs the account's display name and username (S0 spike). */
export const MTCUTE_LOG_OFF = 0;

/**
 * The ONLY runtime load of @mtcute/node. Lazy on purpose: requiring it always loads the native
 * `better-sqlite3` (even with MemoryStorage), so only BANK_FEED_MODE=live and the login CLI pay
 * for it; `off` and `fake` never call this (bank-feed-client.provider.ts). The CJS build is
 * deprecated upstream: import() takes the ESM build; the exact 0.32.7 pin stays (E-26).
 */
export function loadMtcute(): Promise<MtcuteModule> {
  return import('@mtcute/node');
}

export interface MtcuteCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

/**
 * A client that keeps everything in memory: `storage` is ALWAYS a MemoryStorage (without it
 * mtcute opens SqliteStorage("client.session") on disk, S0) and the library's own logging is
 * off. Production DC only: the test DC is not a mode of this code.
 */
export function createTelegram(mod: MtcuteModule, credentials: MtcuteCredentials) {
  const base = new mod.BaseTelegramClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    storage: new mod.MemoryStorage(),
    logLevel: MTCUTE_LOG_OFF,
  });
  return new mod.TelegramClient({ client: base });
}

type Telegram = ReturnType<typeof createTelegram>;

/** The listener's view of the real client; tsc checks each line against mtcute's types. */
export function adaptTelegram(tg: Telegram): MtTelegram {
  // getMe's raw user, kept between resume and begin (notifyLoggedIn needs it).
  let me: Awaited<ReturnType<Telegram['getMe']>> | null = null;
  return {
    onNewMessage: tg.onNewMessage,
    onEditMessage: tg.onEditMessage,
    onError: tg.onError,
    // What start() does for a stored session, without its interactive fallbacks.
    resume: async (session) => {
      await tg.importSession(session, true);
      me = await tg.getMe();
      return { userId: me.id };
    },
    begin: async () => {
      if (me === null) throw new Error('begin() before resume()');
      await tg.notifyLoggedIn(me.raw);
      await tg.startUpdatesLoop();
    },
    // UNVERIFIED on a server (S11): that one dialog page caches the bots' access hashes.
    warmPeers: async () => {
      let count = 0;
      for await (const _dialog of tg.iterDialogs({ limit: 100, archived: 'keep' })) count += 1;
      return count;
    },
    latestMessageId: async (peer) => (await tg.getHistory(peer, { limit: 1 }))[0]?.id ?? null,
    pause: async () => {
      await tg.stopUpdatesLoop();
      await tg.disconnect();
    },
    getHistory: (peer, params) =>
      tg.getHistory(peer, {
        reverse: params.reverse,
        offset: { ...params.offset },
        limit: params.limit,
      }),
    getUsers: (ids) => tg.getUsers([...ids]),
    getAuthorizations: async () =>
      (await tg.call({ _: 'account.getAuthorizations' })).authorizations,
    destroy: () => tg.destroy(),
  };
}

/** The login CLI's view of the real client. */
export function adaptLogin(tg: Telegram): MtLoginTelegram {
  return {
    sendCode: async (phone) => {
      const sent = await tg.sendCode({ phone });
      return 'phoneCodeHash' in sent ? { phoneCodeHash: sent.phoneCodeHash } : null;
    },
    signIn: async (phone, phoneCodeHash, phoneCode) => {
      await tg.signIn({ phone, phoneCodeHash, phoneCode });
    },
    checkPassword: async (password) => {
      await tg.checkPassword(password);
    },
    exportSession: () => tg.exportSession(),
    destroy: () => tg.destroy(),
  };
}
