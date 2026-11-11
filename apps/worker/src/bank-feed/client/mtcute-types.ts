// The narrow slice of @mtcute/node 0.32.7 the bank-feed client uses, as plain structural types.
// mtcute-loader.ts adapts the real TelegramClient to MtTelegram (tsc checks that adapter against
// the library's own types), so everything else, and every unit test, works without loading
// the library or its native SQLite module. Field names are mtcute's (docs: S0 spike report).

/** tl Peer: `peerUser { userId }`, `peerChat { chatId }`, `peerChannel { channelId }`. */
export interface MtPeerRef {
  readonly _: string;
  readonly userId?: number;
  readonly chatId?: number;
  readonly channelId?: number;
}

/** `tl.RawMessage | tl.RawMessageService` (Message.raw). Read through raw: the getters throw on a missing peer. */
export interface MtRawMessage {
  readonly _: string;
  readonly id: number;
  /** Unix seconds: when the message was SENT (never the edit or the forward's original time). */
  readonly date: number;
  readonly out?: boolean;
  readonly peerId: MtPeerRef;
  readonly fromId?: MtPeerRef;
  readonly editDate?: number;
  readonly fwdFrom?: object;
  readonly viaBotId?: number;
  readonly viaBusinessBotId?: number;
  readonly message?: string;
  readonly media?: object;
}

/** Message.sender: a User (`type: 'user'`, `isBot`) or a Chat. */
export interface MtSender {
  readonly type: string;
  readonly id: number;
  readonly isBot?: boolean;
}

export interface MtMessage {
  readonly raw: MtRawMessage;
  /** A getter in mtcute: it may throw when the peer is not cached. */
  readonly sender: MtSender;
}

export interface MtUser {
  readonly id: number;
  readonly isBot: boolean;
  readonly username: string | null;
}

/**
 * `tl.RawAuthorization`. `ip`, `country` and `region` are listed only to say they exist: the
 * client never reads them (they must not reach a log or an alert).
 */
export interface MtAuthorization {
  readonly current?: boolean;
  readonly hash: { toUnsigned(): { toString(): string } };
  readonly dateCreated: number;
  readonly appName?: string;
  readonly deviceModel?: string;
  readonly ip?: string;
  readonly country?: string;
  readonly region?: string;
}

export interface MtEmitter<T> {
  add(listener: (value: T) => void): void;
  remove(listener: (value: T) => void): void;
}

export interface MtHistoryParams {
  readonly reverse: true;
  readonly offset: { readonly id: number; readonly date: number };
  readonly limit: number;
}

/** What the listener needs from a connected client. */
export interface MtTelegram {
  readonly onNewMessage: MtEmitter<MtMessage>;
  readonly onEditMessage: MtEmitter<MtMessage>;
  readonly onError: MtEmitter<Error>;
  /**
   * importSession(force) -> getMe: connects and says whose session it is, nothing more (the
   * account is checked before `begin`, D-52 r2 I-4). What mtcute's `start()` does, without prompts.
   */
  resume(session: string): Promise<{ readonly userId: number }>;
  /** notifyLoggedIn -> startUpdatesLoop, after the account was accepted. */
  begin(): Promise<void>;
  /**
   * Fills mtcute's peer cache from the dialog list (the bots' access hashes) before the pinned
   * bots are resolved by id. Nothing of the dialogs is read: only a count comes back.
   */
  warmPeers(): Promise<number>;
  /** stopUpdatesLoop -> disconnect: the client stays usable, `resume` connects it again. */
  pause(): Promise<void>;
  getHistory(peer: number, params: MtHistoryParams): Promise<readonly MtMessage[]>;
  getUsers(ids: readonly number[]): Promise<readonly (MtUser | null)[]>;
  /** The id of the newest message of a chat (history newest first, limit 1), or null. */
  latestMessageId(peer: number): Promise<number | null>;
  getAuthorizations(): Promise<readonly MtAuthorization[]>;
  destroy(): Promise<void>;
}

/** The login CLI's steps (never `start()`: it re-asks a wrong code forever). */
export interface MtLoginTelegram {
  /** null: already authorized (impossible on a fresh MemoryStorage, treated as an error). */
  sendCode(phone: string): Promise<{ readonly phoneCodeHash: string } | null>;
  signIn(phone: string, phoneCodeHash: string, phoneCode: string): Promise<void>;
  checkPassword(password: string): Promise<void>;
  exportSession(): Promise<string>;
  destroy(): Promise<void>;
}

/** An RPC error's text (`AUTH_KEY_UNREGISTERED`, `FLOOD_WAIT_25`), or null for anything else. */
export function rpcErrorText(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('text' in error)) return null;
  return typeof error.text === 'string' ? error.text : null;
}

/** A loggable error code: the RPC text with digits masked, else the error class name. Never a message. */
export function errorCode(error: unknown): string {
  const text = rpcErrorText(error);
  if (text !== null) return `rpc:${text.replace(/\d+/g, 'N')}`;
  if (!(error instanceof Error)) return 'unknown';
  // mtcute's own errors (MtUnsupportedError, MtPeerNotFoundError) keep name 'Error'.
  return error.name === 'Error' ? error.constructor.name : error.name;
}
