import { LOGIN_NONCE_PATTERN } from '@repo/shared';
import { InlineKeyboard, Keyboard } from 'grammy';
import type { BotContext } from './bot-context';

// "ld:" + 43-char nonce = 46 bytes, under Telegram's 64-byte callback_data cap.
const DENY_PREFIX = 'ld:';
export const DENY_CALLBACK = new RegExp(
  `^${DENY_PREFIX}(${LOGIN_NONCE_PATTERN.source.slice(1, -1)})$`,
);

export function denyCallbackData(nonce: string): string {
  return `${DENY_PREFIX}${nonce}`;
}

export function denyKeyboard(ctx: BotContext, nonce: string): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('bot.login.deny'), denyCallbackData(nonce));
}

/** One-time reply keyboard with the single "share my phone" button. */
export function shareContactKeyboard(ctx: BotContext): Keyboard {
  return new Keyboard().requestContact(ctx.t('bot.login.shareButton')).oneTime().resized();
}
