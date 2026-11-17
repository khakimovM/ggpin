import { BRAND } from '@repo/shared';
import { InlineKeyboard } from 'grammy';
import type { IssueCodeFailure } from '../../auth/login-claim';
import type { DenyResult } from '../../auth/otp-login.service';
import {
  ADMIN_DENY_CALLBACK,
  ADMIN_SESSION_END_CALLBACK,
  adminDenyCallbackData,
} from '../../admin/auth/admin-callbacks';
import type { BotSessionEnd } from '../../admin/auth/admin-session.service';
import type { BotContext } from '../bot-context';
import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';

const HTML = { parse_mode: 'HTML' } as const;
const NO_VALUE = '–';
// Someone who may not use the panel and a stale link read the same (no oracle, docs/04 «Auth»):
// `alreadySent` and `rateLimited` are only reachable by an allowlisted, active admin.
const FAILURE_KEY: Readonly<Record<IssueCodeFailure, string>> = {
  expired: 'bot.admin.linkExpired',
  usedByOther: 'bot.admin.linkExpired',
  alreadySent: 'bot.admin.alreadySent',
  rateLimited: 'bot.login.rateLimited',
};

/** The host the code may be typed on, from the deployment's ADMIN_URL (e.g. admin.ggpin.uz). */
function adminHost(adminUrl: string): string {
  return new URL(adminUrl).host;
}

/**
 * `/start admin_<nonce>`: the admin panel's login code, only for an active, allowlisted admin
 * (the service decides; nobody else learns whether the link is real). No phone is asked. The
 * plain code exists only in this reply; when the reply cannot be sent the link is put back, so it
 * can be opened again, and the error goes on to bot.catch (which scrubs it).
 */
export async function handleAdminLoginStart(
  ctx: BotContext,
  deps: BotDeps,
  nonce: string,
): Promise<void> {
  const telegramId = ctx.user.telegramId;
  const result = await deps.adminLogin.issueCode({ nonce, telegramId, now: deps.clock.now() });
  if (!result.ok) {
    await ctx.reply(ctx.t(FAILURE_KEY[result.reason]), HTML);
    return;
  }
  try {
    await ctx.reply(
      ctx.t('bot.admin.code', {
        code: result.code,
        brand: BRAND.name,
        domain: adminHost(deps.config.ADMIN_URL),
        // Where the login was started (SA-L4): a fixed-list device label and a masked address.
        device: result.origin?.device ?? ctx.t('bot.session.unknownDevice'),
        ip: result.origin?.ip ?? NO_VALUE,
      }),
      {
        ...HTML,
        protect_content: true,
        reply_markup: new InlineKeyboard().text(
          ctx.t('bot.login.deny'),
          adminDenyCallbackData(nonce),
        ),
      },
    );
  } catch (error) {
    try {
      await deps.adminLogin.releaseCode({
        nonce,
        telegramId,
        code: result.code,
        now: deps.clock.now(),
      });
    } catch (releaseError) {
      deps.log.warn(
        `admin code release failed: ${releaseError instanceof Error ? releaseError.name : 'unknown'}`,
      );
    }
    throw error;
  }
}

async function answer(ctx: BotContext, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text === undefined ? {} : { text });
  } catch {
    // The spinner is cosmetic; never throw out of a callback handler.
  }
}

export function registerAdminLogin(bot: TelegramBot, deps: BotDeps): void {
  // "This was not me" under the code message.
  bot.callbackQuery(ADMIN_DENY_CALLBACK, async (ctx) => {
    const nonce = ctx.match[1];
    let result: DenyResult = 'expired';
    try {
      if (nonce !== undefined) {
        result = await deps.adminLogin.deny({
          nonce,
          telegramId: BigInt(ctx.from.id),
          now: deps.clock.now(),
        });
      }
      // Editing replaces the message, so the code leaves the chat too.
      if (result !== 'expired') {
        const key = result === 'sessionEnded' ? 'bot.admin.sessionEnded' : 'bot.admin.denied';
        await ctx.editMessageText(ctx.t(key), { ...HTML, reply_markup: { inline_keyboard: [] } });
      }
    } catch (error) {
      deps.log.warn(`admin login deny failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    await answer(ctx, result === 'expired' ? ctx.t('bot.admin.linkExpired') : undefined);
  });

  // "This was not me" under the new-login message: ends that admin session.
  bot.callbackQuery(ADMIN_SESSION_END_CALLBACK, async (ctx) => {
    const sessionId = ctx.match[1];
    let result: BotSessionEnd = 'alreadyEnded';
    try {
      if (sessionId !== undefined) {
        result = await deps.adminSessions.endFromBot(
          sessionId,
          BigInt(ctx.from.id),
          deps.clock.now(),
        );
      }
      if (result === 'ended') {
        await ctx.editMessageText(ctx.t('bot.admin.sessionEnded'), {
          ...HTML,
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        // A stale button must not stay pressable.
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      }
    } catch (error) {
      deps.log.warn(`admin session end failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    await answer(ctx, result === 'ended' ? undefined : ctx.t('bot.session.alreadyEnded'));
  });
}
