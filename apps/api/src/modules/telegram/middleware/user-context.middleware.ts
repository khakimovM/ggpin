import { parseStartPayload } from '@repo/shared';
import type { Middleware } from 'grammy';
import type { BotContext } from '../bot-context';
import type { BotDeps } from '../bot-deps';
import { translate, translateLenient, type TranslateParams } from '../i18n/translate';
import { startPayloadText } from '../start-text';

/**
 * Resolves the Telegram user into our User for every private-chat update, and exposes
 * `ctx.user`, `ctx.created`, `ctx.locale`, `ctx.t`. Updates without a human sender, or from
 * group chats, stop here. A blocked user gets one fixed reply and nothing else runs.
 */
export function userContext(deps: BotDeps): Middleware<BotContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (from === undefined || from.is_bot || ctx.chat?.type !== 'private') return;

    const payload = parseStartPayload(startPayloadText(ctx.message?.text));
    // photoUrl is deliberately not passed: the only photo URL a bot can get embeds its token.
    const { user, created } = await deps.users.ensureTelegramUser(
      {
        telegramId: BigInt(from.id),
        username: from.username ?? null,
        firstName: from.first_name,
        lastName: from.last_name ?? null,
        languageCode: from.language_code,
      },
      { now: deps.clock.now(), ...(payload.kind === 'ref' ? { refCode: payload.code } : {}) },
    );

    ctx.user = user;
    ctx.created = created;
    ctx.locale = user.locale;
    // Reads ctx.locale at call time, so a language change mid-update is picked up.
    ctx.t = (key: string, params?: TranslateParams): string =>
      deps.config.NODE_ENV === 'production'
        ? translateLenient(ctx.locale, key, params ?? {}, (e) => deps.log.warn(e.message))
        : translate(ctx.locale, key, params);

    if (user.isBlocked) {
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery({ text: ctx.t('bot.errors.blocked'), show_alert: true });
      } else {
        await ctx.reply(ctx.t('bot.errors.blocked'), { parse_mode: 'HTML' });
      }
      return;
    }
    await next();
  };
}
