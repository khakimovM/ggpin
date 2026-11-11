import type { OrderDto } from '@repo/shared';

/**
 * Who the order is for, as a row's second line: "@username" for a Telegram order, the display name
 * for anything else (a game account, a Steam login). Both are user data, so the caller renders
 * them as text only.
 */
export function recipientLabel(order: OrderDto): string {
  const username = order.recipient.fields['username'];
  return username === undefined ? order.recipient.displayName : `@${username}`;
}
