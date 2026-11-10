import type { BankFeedSource, ListenerStopReason } from '@repo/shared';

/**
 * One message of a bank bot's private chat as the Telegram client hands it over (docs/05 §4).
 * Only what the acceptance filter and the ingest step need; nothing of any other chat is ever
 * read. `text` is the raw text: stored with its hash, never logged.
 */
export interface BankFeedMessage {
  /** Telegram message id (one sequence per account: unique across its private chats). */
  readonly id: bigint;
  /** Telegram's message date. */
  readonly date: Date;
  /**
   * The chat the message is in. For the private chat with a bot it is the bot's user id; any
   * other value means the client read a chat it must not: ingest refuses it WITHOUT storing
   * anything (FOREIGN_CHAT, owner alert `foreignChat`, hourly log), and the re-scan fails closed.
   */
  readonly chatId: bigint;
  /** Numeric id of the author: the bot for its notifications, the working account for its own. */
  readonly senderId: bigint;
  /** The author is a bot account (Telegram's `bot` flag of the sender). */
  readonly senderIsBot: boolean;
  readonly text: string;
  /** Written by the working account (an `out` message). */
  readonly outgoing: boolean;
  /** Carries a forward header. */
  readonly forwarded: boolean;
  /** Set when the message was edited after it was sent. */
  readonly editDate: Date | null;
  /** The inline bot it was sent through, if any. */
  readonly viaBotId: bigint | null;
}

/**
 * The history read of the bank-feed Telegram client: all the daily re-scan needs. The listener
 * uses the wider BankFeedListenerClient below (S7: `@mtcute/node` user session, worker only,
 * the session encrypted at rest).
 */
export interface BankFeedClient {
  /**
   * Messages of the source bot's private chat with an id greater than `minId`. Contract (the
   * re-scan relies on it; `bank-feed-client.contract.ts` checks it for every implementation):
   * - OLDEST FIRST: ascending ids, and the page is the `limit` OLDEST messages after `minId`
   *   (history reads usually return the newest first: the S7 client must page from minId up);
   * - at most `limit` messages; an EMPTY page means nothing after `minId` (the only end signal:
   *   a shorter page is not one);
   * - only that one chat; never another chat's messages.
   */
  fetchSince(
    source: BankFeedSource,
    minId: bigint,
    limit: number,
  ): Promise<readonly BankFeedMessage[]>;
}

/** A live update of a source's bot chat: only a nudge to poll that source now (docs/05 §4). */
export interface BankFeedNudge {
  readonly source: BankFeedSource;
  readonly messageId: bigint;
}

/**
 * One authorization (session) of the working account, reduced to what the watch needs. The
 * IP, country and region Telegram also returns are dropped where the client maps it: they never
 * reach a log, an alert or this type.
 */
export interface BankFeedAuthorization {
  /** Telegram's authorization hash as an unsigned decimal (the alert refId). */
  readonly hash: string;
  /** This very session (the worker's own). */
  readonly current: boolean;
  /** Telegram's date_created (null when the server gave none). */
  readonly createdAt: Date | null;
  /** Display labels for the owner (D-52 D1), cut to 128 characters; never the IP or location. */
  readonly appName: string | null;
  readonly deviceModel: string | null;
}

/**
 * Why the listener must stop and not reconnect by itself (alert `listenerStopped`, D-52): the
 * session was revoked (REVOKED) or the account is banned/deleted (BANNED), the same auth key is
 * connected elsewhere (DUPLICATED), a pinned bot is not the bank's (BOT_MISMATCH), or the session
 * belongs to another account than the bound one (ACCOUNT_MISMATCH).
 */
export type BankFeedFatalCode = ListenerStopReason;

/** A failure the listener does not retry: a human must act (runbook). */
export class BankFeedFatalError extends Error {
  constructor(readonly code: BankFeedFatalCode) {
    super(`bank feed stopped: ${code}`);
    this.name = 'BankFeedFatalError';
  }
}

/**
 * The listener side of the client (S7): connect with the decrypted session, live-update nudges
 * for the two bot chats only (any other chat is dropped inside the client, unread), and the
 * account's authorizations. Fatal session problems reject with BankFeedFatalError and are also
 * pushed to `onFatal` when they arrive outside a call (the updates loop).
 */
export interface BankFeedListenerClient extends BankFeedClient {
  /**
   * Connects (again after `stop`); resolves with the account the session belongs to. When given,
   * `verifyAccount` gets that account right after getMe, before the updates loop, the dialog list
   * or the bots (D-52 r2, I-4); its rejection aborts the start.
   */
  start(verifyAccount?: (accountId: bigint) => Promise<void>): Promise<BankFeedSession>;
  /** Disconnects, reversibly: a worker that lost the leader lock may lead again later. */
  stop(): Promise<void>;
  /** Frees everything for good (shutdown). */
  close(): Promise<void>;
  onNewMessage(callback: (nudge: BankFeedNudge) => void): void;
  /** Edits arrive only here (never as a new message), docs/05 §4. */
  onEditMessage(callback: (nudge: BankFeedNudge) => void): void;
  onFatal(callback: (error: BankFeedFatalError) => void): void;
  listAuthorizations(): Promise<readonly BankFeedAuthorization[]>;
  /** The id of the newest message of the source's bot chat (null: empty chat). One call. */
  latestMessageId(source: BankFeedSource): Promise<bigint | null>;
}

export interface BankFeedSession {
  /** The Telegram user id of the working account (getMe), checked against BankFeedAccount. */
  readonly accountId: bigint;
}

/**
 * A read on a client that is not connected (never started, stopped, or closed): thrown before
 * anything reaches Telegram, so a worker that is not the leader never opens a second
 * connection by itself (mtcute's `call()` would reconnect on its own, D-52).
 */
export class BankFeedNotConnectedError extends Error {
  constructor() {
    super('the bank-feed client is not connected');
    this.name = 'BankFeedNotConnectedError';
  }
}

/**
 * DI token of the client: `null` with BANK_FEED_MODE=off (the re-scan then reports
 * `historyScan: unavailable`, never a silent "ok"), the in-memory client with `fake`, the
 * MTProto client with `live` (bank-feed-client.provider.ts).
 */
export const BANK_FEED_CLIENT = Symbol('BANK_FEED_CLIENT');
