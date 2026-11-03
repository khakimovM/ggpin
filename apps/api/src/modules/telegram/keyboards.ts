import { LOCALES, type Locale } from '@repo/shared';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from './bot-context';

export const CB_HELP = 'help';
export const CB_LANG_MENU = 'lang:menu';
const LANG_PREFIX = 'lang:';

export interface KeyboardConfig {
  readonly MINI_APP_URL?: string | undefined;
  readonly TELEGRAM_NEWS_CHANNEL_URL?: string | undefined;
}

export type LangChoice =
  { readonly kind: 'menu' } | { readonly kind: 'set'; readonly locale: Locale };

/** Callback data is client-controlled: accept only the exact values we hand out. */
export function parseLangCallback(data: string): LangChoice | null {
  if (data === CB_LANG_MENU) return { kind: 'menu' };
  if (!data.startsWith(LANG_PREFIX)) return null;
  const locale = LOCALES.find((l) => l === data.slice(LANG_PREFIX.length));
  return locale === undefined ? null : { kind: 'set', locale };
}

/** Shop button; the web_app button exists only when MINI_APP_URL is set (dev without HTTPS). */
export function shopKeyboard(ctx: BotContext, config: KeyboardConfig): InlineKeyboard | undefined {
  if (config.MINI_APP_URL === undefined) return undefined;
  return new InlineKeyboard().webApp(ctx.t('bot.start.buttons.shop'), config.MINI_APP_URL);
}

export function startKeyboard(ctx: BotContext, config: KeyboardConfig): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (config.MINI_APP_URL !== undefined) {
    kb.webApp(ctx.t('bot.start.buttons.shop'), config.MINI_APP_URL).row();
  }
  if (config.TELEGRAM_NEWS_CHANNEL_URL !== undefined) {
    kb.url(ctx.t('bot.start.buttons.news'), config.TELEGRAM_NEWS_CHANNEL_URL).row();
  }
  return kb
    .text(ctx.t('bot.start.buttons.help'), CB_HELP)
    .text(ctx.t('bot.start.buttons.language'), CB_LANG_MENU);
}

/** Always shows both languages by their own names, whatever the user's locale is. */
export function languageKeyboard(ctx: BotContext): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const locale of LOCALES) {
    kb.text(ctx.t(`bot.lang.options.${locale}`), `${LANG_PREFIX}${locale}`);
  }
  return kb;
}
