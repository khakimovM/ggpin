import type { BankFeedMessage } from './bank-feed-client';
import type { MtMessage, MtPeerRef } from './mtcute-types';

// Channel ids are marked -100<id> by Telegram clients; any non-user peer just has to differ from
// every (positive) bot id, so groups and channels map to negative numbers.
const CHANNEL_MARK = 1_000_000_000_000n;

/** A peer as one signed id: users positive (their id), groups and channels negative. */
export function peerIdOf(peer: MtPeerRef): bigint {
  if (peer._ === 'peerUser' && peer.userId !== undefined) return BigInt(peer.userId);
  if (peer._ === 'peerChat' && peer.chatId !== undefined) return -BigInt(peer.chatId);
  if (peer._ === 'peerChannel' && peer.channelId !== undefined) {
    return -(CHANNEL_MARK + BigInt(peer.channelId));
  }
  return -1n;
}

/**
 * The text the ingest step stores and parses. A service message has none; a media message
 * (anything but a link preview) is not a bank notification, so its caption is not used: it is
 * stored with an empty text and becomes an UNRECOGNIZED review, never money (S6: media is not
 * parsed).
 */
function textOf(message: MtMessage): string {
  const raw = message.raw;
  if (raw._ !== 'message') return '';
  const media = raw.media;
  if (media !== undefined && '_' in media && media._ !== 'messageMediaWebPage') return '';
  return raw.message ?? '';
}

/**
 * The `sender` getter threw for a message the chat's own peer seems to have sent (D-52 r2, review
 * M-B): a client problem (the peer is not cached), not a security anomaly. The whole page is not
 * ingested: the poll fails, nothing is stored, the cursor stays, the round is unhealthy and the
 * watchdog alerts `listenerDown` after 5 minutes. (Before, each such bank message was NOT_BOT:
 * an anomaly alert and an all-cards pause per message.)
 */
export class BankFeedSenderUnknownError extends Error {
  constructor() {
    super('the sender of a bank bot message could not be resolved');
    this.name = 'BankFeedSenderUnknownError';
  }
}

// An outgoing message or one with another fromId is refused by the filter (OUTGOING /
// FOREIGN_SENDER) before the bot flag matters: there an unknown sender is simply "not a bot".
function senderIsBot(message: MtMessage, senderId: bigint, chatId: bigint): boolean {
  let sender: MtMessage['sender'];
  try {
    sender = message.sender;
  } catch {
    if (message.raw.out === true || senderId !== chatId) return false;
    throw new BankFeedSenderUnknownError();
  }
  return sender.type === 'user' && sender.isBot === true && BigInt(sender.id) === senderId;
}

/**
 * mtcute Message -> BankFeedMessage, from the raw TL fields. `date` is MTProto `message.date`,
 * the time the message was SENT: an edit sets `editDate` and a forward keeps its original time in
 * `fwdFrom.date`, neither changes `date` (S9 security I1, D-47). The sender of a private-chat
 * message without `fromId` is the chat's user, as mtcute's own `sender` getter says.
 */
export function toBankFeedMessage(message: MtMessage): BankFeedMessage {
  const raw = message.raw;
  const chatId = peerIdOf(raw.peerId);
  const senderId = raw.fromId !== undefined ? peerIdOf(raw.fromId) : chatId;
  const via = raw.viaBotId ?? raw.viaBusinessBotId;
  return {
    id: BigInt(raw.id),
    date: new Date(raw.date * 1000),
    chatId,
    senderId,
    senderIsBot: senderIsBot(message, senderId, chatId),
    text: textOf(message),
    outgoing: raw.out === true,
    forwarded: raw.fwdFrom !== undefined,
    editDate:
      raw.editDate === undefined || raw.editDate === 0 ? null : new Date(raw.editDate * 1000),
    viaBotId: via === undefined || via === 0 ? null : BigInt(via),
  };
}
