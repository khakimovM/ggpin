import { parseStartPayload } from '@repo/shared';
import type { Middleware } from 'grammy';
import { ADMIN_DENY_CALLBACK, ADMIN_SESSION_END_CALLBACK } from '../../admin/auth/admin-callbacks';
import type { BotContext } from '../bot-context';
import type { BotDeps } from '../bot-deps';
import { translate, translateLenient, type TranslateParams } from '../../../common/i18n/translate';
import { startPayloadText } from '../start-text';

/**
 * Resolves the Telegram user into our User for every private-chat update, and exposes
 * `ctx.user`, `ctx.created`, `ctx.locale`, `ctx.t`. Updates without a human sender, or from
 * group chats, stop here. A blocked user gets one fixed reply and nothing else runs, except the
 * admin login (SA-S6-1): `/start admin_<nonce>` and the admin "this was not me" buttons go on, so
 * an admin whose store account was blocked still gets the panel code and can still end a session.
 * Who may use them is decided by the admin services (allowlisted, active AdminUser), as for an
 * unblocked account: anyone else gets the same "link expired" answer.
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

    if (user.isBlocked && !isAdminLoginUpdate(payload.kind, ctx.callbackQuery?.data)) {
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

function isAdminLoginUpdate(payloadKind: string, callbackData: string | undefined): boolean {
  if (payloadKind === 'admin') return true;
  if (callbackData === undefined) return false;
  return ADMIN_DENY_CALLBACK.test(callbackData) || ADMIN_SESSION_END_CALLBACK.test(callbackData);
}
