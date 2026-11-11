import type { BankFeedSource } from '@repo/shared';
import type {
  BankFeedAuthorization,
  BankFeedFatalError,
  BankFeedListenerClient,
  BankFeedMessage,
  BankFeedNudge,
  BankFeedSession,
} from './bank-feed-client';

type Listener<T> = (value: T) => void;

/**
 * In-memory bank-feed client (BANK_FEED_MODE=fake and tests): the chats are whatever the test
 * put in. No network, no Telegram. `failWith` makes the next reads fail, to show what an
 * unreachable Telegram does; `emitNew` / `emitEdit` / `emitFatal` play live updates.
 */
export class FakeBankFeedClient implements BankFeedListenerClient {
  private readonly chats = new Map<BankFeedSource, BankFeedMessage[]>();
  private readonly otherChats: BankFeedMessage[] = [];
  private readonly newListeners: Listener<BankFeedNudge>[] = [];
  private readonly editListeners: Listener<BankFeedNudge>[] = [];
  private readonly fatalListeners: Listener<BankFeedFatalError>[] = [];
  failWith: Error | null = null;
  /** What `start` rejects with (null: it starts). */
  startFailure: Error | null = null;
  /** Like Telegram, at least the current session (its hash is 0, S0 spike). */
  authorizations: BankFeedAuthorization[] = [
    { hash: '0', current: true, createdAt: null, appName: 'fake', deviceModel: 'fake' },
  ];
  /** The account `start` reports (BankFeedAccount binding, D-52 D4). */
  accountId = 7_000_000_001n;
  started = false;
  closed = false;
  starts = 0;
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

  async start(verifyAccount?: (accountId: bigint) => Promise<void>): Promise<BankFeedSession> {
    this.starts += 1;
    if (this.startFailure !== null) throw this.startFailure;
    if (verifyAccount !== undefined) await verifyAccount(this.accountId);
    this.started = true;
    return { accountId: this.accountId };
  }

  latestMessageId(source: BankFeedSource): Promise<bigint | null> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve(this.chats.get(source)?.at(-1)?.id ?? null);
  }

  stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.started = false;
    this.closed = true;
    return Promise.resolve();
  }

  onNewMessage(callback: Listener<BankFeedNudge>): void {
    this.newListeners.push(callback);
  }

  onEditMessage(callback: Listener<BankFeedNudge>): void {
    this.editListeners.push(callback);
  }

  onFatal(callback: Listener<BankFeedFatalError>): void {
    this.fatalListeners.push(callback);
  }

  listAuthorizations(): Promise<readonly BankFeedAuthorization[]> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve([...this.authorizations]);
  }

  emitNew(nudge: BankFeedNudge): void {
    for (const listener of this.newListeners) listener(nudge);
  }

  emitEdit(nudge: BankFeedNudge): void {
    for (const listener of this.editListeners) listener(nudge);
  }

  emitFatal(error: BankFeedFatalError): void {
    for (const listener of this.fatalListeners) listener(error);
  }
}
