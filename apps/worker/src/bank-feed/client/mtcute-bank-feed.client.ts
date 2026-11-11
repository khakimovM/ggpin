import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import {
  BankFeedFatalError,
  BankFeedNotConnectedError,
  type BankFeedAuthorization,
  type BankFeedFatalCode,
  type BankFeedListenerClient,
  type BankFeedMessage,
  type BankFeedNudge,
  type BankFeedSession,
} from './bank-feed-client';
import { HourlyCounter } from './hourly-counter';
import { peerIdOf, toBankFeedMessage } from './mtcute-message';
import { errorCode, rpcErrorText, type MtMessage, type MtTelegram } from './mtcute-types';

/** The bots' public usernames (docs/05 §4), compared once at start with what the pinned ids are. */
export const BANK_BOT_USERNAMES: Readonly<Record<BankFeedSource, string>> = {
  HUMO_BOT: 'HUMOcardbot',
  UZCARD_BOT: 'CardXabarBot',
};

/** RPC error texts that end the session for good, by the reason the owner is told (D-52). */
const FATAL_RPC: Readonly<Record<string, BankFeedFatalCode>> = {
  AUTH_KEY_UNREGISTERED: 'REVOKED',
  AUTH_KEY_INVALID: 'REVOKED',
  SESSION_REVOKED: 'REVOKED',
  SESSION_EXPIRED: 'REVOKED',
  USER_DEACTIVATED: 'BANNED',
  USER_DEACTIVATED_BAN: 'BANNED',
  AUTH_KEY_DUPLICATED: 'DUPLICATED',
};

/** The fatal code of an error, or null when it may be retried. */
export function fatalCodeOf(error: unknown): BankFeedFatalCode | null {
  if (error instanceof BankFeedFatalError) return error.code;
  const text = rpcErrorText(error);
  return text === null ? null : (FATAL_RPC[text] ?? null);
}

/** Display labels are cut: they are shown to the owner, nothing more (DB CHECK <= 128). */
const LABEL_MAX = 128;
/**
 * Code points dropped from a label (D-52 r2, review I-5): C0 (a NUL would fail the INSERT on every
 * round), DEL + C1, and the bidi marks, overrides and isolates (ALM, LRM/RLM, LRE..RLO, LRI..PDI):
 * the session's owner chooses these strings.
 */
function unsafeCodePoint(c: number): boolean {
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x061c ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

export const label = (value: string | undefined): string | null => {
  const kept = Array.from(value ?? '').filter((ch) => !unsafeCodePoint(ch.codePointAt(0) ?? 0));
  const clean = kept.join('').trim().slice(0, LABEL_MAX);
  return clean === '' ? null : clean;
};

export interface MtcuteClientOptions {
  /** The pinned bot of each source (BANK_FEED_*_BOT_ID). */
  readonly bots: Readonly<Record<BankFeedSource, bigint>>;
  /** Opens BANK_FEED_SESSION_ENC; called once per start, the plaintext is not kept. */
  readonly openSession: () => string;
  readonly usernames?: Readonly<Record<BankFeedSource, string>>;
}

const SOURCES: readonly BankFeedSource[] = ['HUMO_BOT', 'UZCARD_BOT'];

/**
 * The live bank-feed client over an mtcute user session (docs/05 §4, plan S7). Reads only the two
 * pinned bot chats: `fetchSince` asks for that one peer's history, and live updates of any other
 * chat are dropped here before anything of them is read (S9 B2: their text goes nowhere). Edits
 * arrive only on `onEditMessage`, so both are listened to. Logs carry error codes only.
 *
 * NOT VERIFIED ON A SERVER (owner decision 2026-11-09; S11 with the working account): the
 * `getHistory(peer, { reverse: true, offset: { id: minId + 1, date: 0 } })` paging (spike: the
 * offset is inclusive, `reverse` without an offset returns nothing), resolving a pinned bot by id
 * alone (mtcute tries `users.getUsers` with access hash 0 when the peer is not cached), live
 * updates, `account.getAuthorizations`, the dialog page that warms the peer cache, and getMe's id.
 *
 * Reads refuse with BankFeedNotConnectedError unless `start` succeeded and no `stop` followed:
 * mtcute's `call()` reconnects by itself, so without this a worker that is no longer the leader
 * could open a second connection with the same auth key (D-52).
 */
export class MtcuteBankFeedClient implements BankFeedListenerClient {
  private readonly logger = new Logger('MtcuteBankFeedClient');
  private readonly errors = new HourlyCounter();
  private readonly newListeners: ((nudge: BankFeedNudge) => void)[] = [];
  private readonly editListeners: ((nudge: BankFeedNudge) => void)[] = [];
  private readonly fatalListeners: ((error: BankFeedFatalError) => void)[] = [];
  private readonly onNew = (message: MtMessage): void => this.nudge(message, this.newListeners);
  private readonly onEdit = (message: MtMessage): void => this.nudge(message, this.editListeners);
  private readonly onError = (error: Error): void => this.clientError(error);
  private subscribed = false;
  private destroyed = false;
  private connected = false;

  constructor(
    private readonly tg: MtTelegram,
    private readonly options: MtcuteClientOptions,
  ) {}

  /**
   * Connects; getMe's account goes to `verifyAccount` FIRST (D-52 r2, review I-4): a session of
   * another account is refused before the updates loop starts, before the dialog list is read and
   * before any bot is resolved, so nothing of a foreign account reaches memory.
   */
  async start(verifyAccount?: (accountId: bigint) => Promise<void>): Promise<BankFeedSession> {
    if (this.destroyed) throw new Error('the bank-feed client was closed; build a new one');
    const me = await this.guard(() => this.tg.resume(this.options.openSession()));
    const accountId = BigInt(me.userId);
    if (verifyAccount !== undefined) await verifyAccount(accountId);
    if (!this.subscribed) {
      this.tg.onNewMessage.add(this.onNew);
      this.tg.onEditMessage.add(this.onEdit);
      this.tg.onError.add(this.onError);
      this.subscribed = true;
    }
    await this.guard(() => this.tg.begin());
    // The pinned bots are resolved by id: their access hashes come from the dialog list, so the
    // peer cache is filled first (D-52). That a fresh MemoryStorage session really resolves them
    // this way is verified on the real server in S11.
    await this.guard(() => this.tg.warmPeers());
    await this.verifyBots();
    this.connected = true;
    return { accountId };
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.unsubscribe();
    if (!this.destroyed) await this.tg.pause();
  }

  async close(): Promise<void> {
    this.connected = false;
    this.unsubscribe();
    if (this.destroyed) return;
    this.destroyed = true;
    await this.tg.destroy();
  }

  private unsubscribe(): void {
    if (!this.subscribed) return;
    this.tg.onNewMessage.remove(this.onNew);
    this.tg.onEditMessage.remove(this.onEdit);
    this.tg.onError.remove(this.onError);
    this.subscribed = false;
  }

  async fetchSince(
    source: BankFeedSource,
    minId: bigint,
    limit: number,
  ): Promise<readonly BankFeedMessage[]> {
    this.assertConnected();
    const peer = safeNumber(this.options.bots[source]);
    // reverse = oldest -> newest starting AT offset.id (inclusive), hence minId + 1.
    const offset = { id: safeNumber(minId) + 1, date: 0 };
    const page = await this.guard(() => this.tg.getHistory(peer, { reverse: true, offset, limit }));
    // Defensive: the contract is enforced here too, whatever order the server used.
    return page
      .map(toBankFeedMessage)
      .filter((m) => m.id > minId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  onNewMessage(callback: (nudge: BankFeedNudge) => void): void {
    this.newListeners.push(callback);
  }

  onEditMessage(callback: (nudge: BankFeedNudge) => void): void {
    this.editListeners.push(callback);
  }

  onFatal(callback: (error: BankFeedFatalError) => void): void {
    this.fatalListeners.push(callback);
  }

  async listAuthorizations(): Promise<readonly BankFeedAuthorization[]> {
    this.assertConnected();
    const list = await this.guard(() => this.tg.getAuthorizations());
    // Only these fields are read: ip, country and region never leave this line.
    return list.map((a) => ({
      hash: a.hash.toUnsigned().toString(),
      current: a.current === true,
      createdAt: a.dateCreated > 0 ? new Date(a.dateCreated * 1000) : null,
      appName: label(a.appName),
      deviceModel: label(a.deviceModel),
    }));
  }

  async latestMessageId(source: BankFeedSource): Promise<bigint | null> {
    this.assertConnected();
    const peer = safeNumber(this.options.bots[source]);
    const id = await this.guard(() => this.tg.latestMessageId(peer));
    return id === null ? null : BigInt(id);
  }

  private assertConnected(): void {
    if (!this.connected || this.destroyed) throw new BankFeedNotConnectedError();
  }

  /** The pinned ids must be bots with the expected usernames, or nothing starts (fail closed). */
  private async verifyBots(): Promise<void> {
    const usernames = this.options.usernames ?? BANK_BOT_USERNAMES;
    const ids = SOURCES.map((source) => safeNumber(this.options.bots[source]));
    const users = await this.guard(() => this.tg.getUsers(ids));
    SOURCES.forEach((source, index) => {
      const user = users[index] ?? null;
      const expected = usernames[source].toLowerCase();
      const ok =
        user !== null &&
        user.isBot &&
        user.id === ids[index] &&
        user.username?.toLowerCase() === expected;
      if (!ok) {
        this.logger.error(`pinned bot of ${source} is not the expected bank bot: BOT_MISMATCH`);
        throw new BankFeedFatalError('BOT_MISMATCH');
      }
    });
  }

  private nudge(message: MtMessage, listeners: readonly ((nudge: BankFeedNudge) => void)[]) {
    // Only the chat id is looked at: another chat's update is dropped unread.
    const chatId = peerIdOf(message.raw.peerId);
    const source = SOURCES.find((s) => this.options.bots[s] === chatId);
    if (source === undefined) return;
    const nudge = { source, messageId: BigInt(message.raw.id) };
    for (const listener of listeners) listener(nudge);
  }

  private clientError(error: Error): void {
    const fatal = fatalCodeOf(error);
    if (fatal !== null) {
      const wrapped = new BankFeedFatalError(fatal);
      for (const listener of this.fatalListeners) listener(wrapped);
      return;
    }
    const code = errorCode(error);
    // Reconnects can repeat an error many times a minute: once an hour per code.
    if (this.errors.hit(code, new Date()).logNow) this.logger.warn(`mtcute error: ${code}`);
  }

  /** Runs a call, turning a fatal RPC error into BankFeedFatalError. */
  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const fatal = fatalCodeOf(error);
      if (fatal !== null) throw new BankFeedFatalError(fatal);
      throw error;
    }
  }
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('telegram id out of the safe integer range');
  }
  return Number(value);
}
