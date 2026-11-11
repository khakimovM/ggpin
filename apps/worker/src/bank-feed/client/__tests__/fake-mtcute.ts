import type {
  MtAuthorization,
  MtEmitter,
  MtHistoryParams,
  MtMessage,
  MtRawMessage,
  MtSender,
  MtTelegram,
  MtUser,
} from '../mtcute-types';

// A stand-in for the mtcute TelegramClient (owner decision 2026-11-09: no test talks to Telegram,
// not even the test DC). Its history follows what the S0 spike read in mtcute 0.32.7:
// `reverse: true` returns oldest -> newest starting AT offset.id (inclusive), and an offset id of
// 0 with `reverse` returns nothing. All values are synthetic.

export class FakeEmitter<T> implements MtEmitter<T> {
  readonly listeners: ((value: T) => void)[] = [];

  add(listener: (value: T) => void): void {
    this.listeners.push(listener);
  }

  remove(listener: (value: T) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export interface RawOptions extends Partial<MtRawMessage> {
  readonly sender?: MtSender | (() => MtSender);
}

/** A message object shaped like mtcute's: `raw` fields plus a `sender` getter. */
export function mtMessage(id: number, peerUserId: number, options: RawOptions = {}): MtMessage {
  const { sender, ...raw } = options;
  const full: MtRawMessage = {
    _: 'message',
    id,
    date: 1_900_000_000 + id,
    peerId: { _: 'peerUser', userId: peerUserId },
    message: 'synthetic',
    ...raw,
  };
  return {
    raw: full,
    get sender(): MtSender {
      if (typeof sender === 'function') return sender();
      return sender ?? { type: 'user', id: peerUserId, isBot: true };
    },
  };
}

export class FakeTelegram implements MtTelegram {
  readonly onNewMessage = new FakeEmitter<MtMessage>();
  readonly onEditMessage = new FakeEmitter<MtMessage>();
  readonly onError = new FakeEmitter<Error>();
  /** peer -> messages of that one chat. */
  readonly history = new Map<number, MtMessage[]>();
  readonly historyCalls: { peer: number; params: MtHistoryParams }[] = [];
  users: (MtUser | null)[] = [];
  authorizations: MtAuthorization[] = [];
  resumedWith: string[] = [];
  failNext: Error | null = null;
  paused = 0;
  destroyed = 0;
  /** getMe's id after a resume (synthetic). */
  meId = 7_000_000_001;
  warmed = 0;
  latestCalls: number[] = [];

  put(peer: number, message: MtMessage): void {
    const chat = this.history.get(peer) ?? [];
    chat.push(message);
    this.history.set(peer, chat);
  }

  async resume(session: string): Promise<{ readonly userId: number }> {
    this.resumedWith.push(session);
    await this.maybeFail();
    return { userId: this.meId };
  }

  /** How many times the updates loop was started (after the account check). */
  begun = 0;

  async begin(): Promise<void> {
    this.begun += 1;
    await this.maybeFail();
  }

  async warmPeers(): Promise<number> {
    this.warmed += 1;
    await this.maybeFail();
    return this.history.size;
  }

  async latestMessageId(peer: number): Promise<number | null> {
    this.latestCalls.push(peer);
    await this.maybeFail();
    const ids = (this.history.get(peer) ?? []).map((m) => m.raw.id);
    return ids.length === 0 ? null : Math.max(...ids);
  }

  pause(): Promise<void> {
    this.paused += 1;
    return Promise.resolve();
  }

  async getHistory(peer: number, params: MtHistoryParams): Promise<readonly MtMessage[]> {
    this.historyCalls.push({ peer, params });
    await this.maybeFail();
    if (params.offset.id === 0) return [];
    return (this.history.get(peer) ?? [])
      .filter((m) => m.raw.id >= params.offset.id)
      .sort((a, b) => a.raw.id - b.raw.id)
      .slice(0, params.limit);
  }

  async getUsers(ids: readonly number[]): Promise<readonly (MtUser | null)[]> {
    await this.maybeFail();
    return ids.map((id) => this.users.find((u) => u?.id === id) ?? null);
  }

  async getAuthorizations(): Promise<readonly MtAuthorization[]> {
    await this.maybeFail();
    return this.authorizations;
  }

  destroy(): Promise<void> {
    this.destroyed += 1;
    return Promise.resolve();
  }

  private maybeFail(): Promise<void> {
    const error = this.failNext;
    this.failNext = null;
    return error === null ? Promise.resolve() : Promise.reject(error);
  }
}

/** An mtcute RpcError look-alike: the client reads `.text` only. */
export class FakeRpcError extends Error {
  constructor(
    readonly text: string,
    readonly code = 401,
  ) {
    super(`${String(code)}: ${text} (synthetic, may carry +998000000000)`);
    this.name = 'RpcError';
  }
}

export function authorization(hash: bigint, extra: Partial<MtAuthorization> = {}): MtAuthorization {
  return {
    hash: { toUnsigned: () => ({ toString: () => hash.toString() }) },
    dateCreated: 1_900_000_000,
    appName: 'Test Desktop',
    deviceModel: 'Test PC',
    ip: '203.0.113.77',
    country: 'Testland',
    region: 'Test Region',
    ...extra,
  };
}
