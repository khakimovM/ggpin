import type { BankFeedSource } from '@repo/shared';

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
 * The bank-feed Telegram client (S7: `@mtcute/node` user session, worker only, the session
 * encrypted at rest). S9 needs only the history read of the daily re-scan; S7 adds `start`,
 * `stop`, `onNewMessage` and `listAuthorizations` next to it.
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

/**
 * DI token of the client. `null` while no client is configured (BANK_FEED_MODE off, and every
 * mode until S7 wires the real one): the re-scan then reports `historyScan: unavailable`, never
 * a silent "ok".
 */
export const BANK_FEED_CLIENT = Symbol('BANK_FEED_CLIENT');
