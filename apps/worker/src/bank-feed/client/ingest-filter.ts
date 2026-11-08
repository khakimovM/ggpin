import { FOREIGN_INGEST_REASONS, type IngestRejectReason } from '@repo/shared';
import type { BankFeedMessage } from './bank-feed-client';

type FilterFields =
  'chatId' | 'senderId' | 'senderIsBot' | 'outgoing' | 'forwarded' | 'editDate' | 'viaBotId';

/**
 * The acceptance filter before the parser (docs/05 §4): only a message the pinned numeric bot
 * itself sent in its own private chat, from a bot account, not forwarded, never edited, not
 * through an inline bot, not written by the working account. A message of another chat is
 * refused without being stored (IngestService); anything else is stored REJECTED
 * with this code and never becomes money. Pure: no I/O, the text is not looked at.
 */
export function ingestRejectReason(
  message: Pick<BankFeedMessage, FilterFields>,
  pinnedBotId: bigint,
): IngestRejectReason | null {
  // Another chat first: nothing of it is stored at all (its ids are not this chat's, B2).
  if (message.chatId !== pinnedBotId) return 'FOREIGN_CHAT';
  if (message.outgoing) return 'OUTGOING';
  if (message.forwarded) return 'FORWARDED';
  if (message.editDate !== null) return 'EDITED';
  if (message.viaBotId !== null) return 'VIA_BOT';
  if (message.senderId !== pinnedBotId) return 'FOREIGN_SENDER';
  if (!message.senderIsBot) return 'NOT_BOT';
  return null;
}

/** Someone else's words (another chat, another sender, not a bot): store only the hash. */
export function isForeignText(reason: IngestRejectReason | null): boolean {
  return reason !== null && FOREIGN_INGEST_REASONS.includes(reason);
}
