import type { User } from '@repo/db';
import type { Locale } from '@repo/shared';
import type { Context } from 'grammy';
import type { TranslateParams } from './i18n/translate';

/** Added to every update by the user-context middleware (never present on chat-member updates). */
export interface BotFlavor {
  user: User;
  /** True only on the update that created the user. */
  created: boolean;
  locale: Locale;
  t(key: string, params?: TranslateParams): string;
}

export type BotContext = Context & BotFlavor;
