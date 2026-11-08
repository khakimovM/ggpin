import type { BankFeedSource } from '@repo/shared';
import type { BankFeedClient, BankFeedMessage } from './bank-feed-client';

/**
 * In-memory bank-feed client (BANK_FEED_MODE=fake and tests): the chats are whatever the test
 * or the dev inject tool put in. No network, no Telegram. `failWith` makes the next reads fail,
 * to show what an unreachable Telegram does to the re-scan.
 */
export class FakeBankFeedClient implements BankFeedClient {
  private readonly chats = new Map<BankFeedSource, BankFeedMessage[]>();
  private readonly otherChats: BankFeedMessage[] = [];
  failWith: Error | null = null;
  /** Every fetchSince call, for assertions on paging. */
  readonly calls: { source: BankFeedSource; minId: bigint; limit: number }[] = [];

  put(source: BankFeedSource, message: BankFeedMessage): void {
    const chat = this.chats.get(source) ?? [];
    chat.push(message);
    chat.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.chats.set(source, chat);
  }

  /**
   * A message of a chat that is not a source's bot chat: kept apart and never returned, like
   * the real client must (the contract's "another chat" case).
   */
  putOtherChat(message: BankFeedMessage): void {
    this.otherChats.push(message);
  }

  clear(): void {
    this.chats.clear();
    this.otherChats.length = 0;
    this.calls.length = 0;
    this.failWith = null;
  }

  fetchSince(
    source: BankFeedSource,
    minId: bigint,
    limit: number,
  ): Promise<readonly BankFeedMessage[]> {
    this.calls.push({ source, minId, limit });
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const chat = this.chats.get(source) ?? [];
    return Promise.resolve(chat.filter((m) => m.id > minId).slice(0, limit));
  }
}
