import { BRAND } from '@repo/shared';
import type { DenyResult, IssueCodeFailure } from '../../auth/otp-login.service';
import { AppError } from '../../../common/exceptions/app-error';
import type { BotContext } from '../bot-context';
import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';
import { DENY_CALLBACK, denyKeyboard, shareContactKeyboard } from '../login-keyboards';
import { normalizePhone } from '../phone';

const HTML = { parse_mode: 'HTML' } as const;
const FAILURE_KEY: Readonly<Record<IssueCodeFailure, string>> = {
  expired: 'bot.login.expired',
  alreadySent: 'bot.login.alreadySent',
  usedByOther: 'bot.login.usedByOther',
  rateLimited: 'bot.login.rateLimited',
};

/** `/start login_<nonce>`: hands out the code, or first asks for the phone of a phone-less user. */
export async function handleLoginStart(
  ctx: BotContext,
  deps: BotDeps,
  nonce: string,
): Promise<void> {
  if (ctx.user.phone !== null) {
    await issueAndReply(ctx, deps, nonce);
    return;
  }
  // Do not ask for a phone on a link that can no longer be used. A phone-less account cannot
  // hold a code yet, so CODE_SENT means somebody else has the link.
  const state = await linkState(deps, nonce);
  if (state !== 'PENDING') {
    await ctx.reply(
      ctx.t(state === 'CODE_SENT' ? 'bot.login.usedByOther' : 'bot.login.expired'),
      HTML,
    );
    return;
  }
  await deps.loginContact.remember(ctx.user.telegramId, nonce);
  await ctx.reply(ctx.t('bot.login.sharePhone'), {
    ...HTML,
    reply_markup: shareContactKeyboard(ctx),
  });
}

async function linkState(deps: BotDeps, nonce: string): Promise<'PENDING' | 'CODE_SENT' | 'DEAD'> {
  try {
    const { status } = await deps.login.status(nonce, deps.clock.now());
    return status === 'PENDING' || status === 'CODE_SENT' ? status : 'DEAD';
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return 'DEAD';
    throw error;
  }
}

async function issueAndReply(ctx: BotContext, deps: BotDeps, nonce: string): Promise<void> {
  const result = await deps.login.issueCode({
    nonce,
    telegramId: ctx.user.telegramId,
    now: deps.clock.now(),
  });
  if (!result.ok) {
    await ctx.reply(ctx.t(FAILURE_KEY[result.reason]), HTML);
    return;
  }
  await sendCode(ctx, deps, nonce, result.code);
}

// The only place a plain code exists: it goes straight into this reply and nowhere else.
// If anything up to and including the code message fails the user never saw the code, so the
// link is put back to PENDING (they can open it again) and the error goes on to bot.catch,
// which scrubs it. `before` is whatever must be sent first and is covered by the same release.
async function sendCode(
  ctx: BotContext,
  deps: BotDeps,
  nonce: string,
  code: string,
  before?: () => Promise<unknown>,
): Promise<void> {
  try {
    await before?.();
    await ctx.reply(ctx.t('bot.login.code', { code, brand: BRAND.name, domain: BRAND.domain }), {
      ...HTML,
      protect_content: true,
      reply_markup: denyKeyboard(ctx, nonce),
    });
  } catch (error) {
    try {
      await deps.login.releaseCode({
        nonce,
        telegramId: ctx.user.telegramId,
        code,
        now: deps.clock.now(),
      });
    } catch (releaseError) {
      deps.log.warn(
        `login code release failed: ${releaseError instanceof Error ? releaseError.name : 'unknown'}`,
      );
    }
    throw error;
  }
}

export function registerLogin(bot: TelegramBot, deps: BotDeps): void {
  bot.on('message:contact', async (ctx) => {
    const { contact } = ctx.message;
    // Anyone can forward somebody else's contact card: only the sender's own number counts.
    if (contact.user_id !== ctx.from.id) {
      await ctx.reply(ctx.t('bot.login.contactNotYours'), HTML);
      return;
    }
    const phone = normalizePhone(contact.phone_number);
    if (phone === null) {
      await ctx.reply(ctx.t('bot.login.contactInvalid'), HTML);
      return;
    }
    const nonce = await deps.loginContact.take(BigInt(ctx.from.id));
    if (nonce === null) {
      // A phone is only taken as part of a login, never stored on its own.
      await ctx.reply(ctx.t('bot.login.expired'), {
        ...HTML,
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    // The phone is stored only together with a login that really starts: a dead or foreign
    // link must not leave a number behind.
    const result = await deps.login.issueCode({
      nonce,
      telegramId: ctx.user.telegramId,
      now: deps.clock.now(),
    });
    if (!result.ok) {
      await ctx.reply(ctx.t(FAILURE_KEY[result.reason]), {
        ...HTML,
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    // One message carries one reply_markup, so the keyboard goes away with a short
    // confirmation and the code arrives as its own message with the inline button.
    await sendCode(ctx, deps, nonce, result.code, () =>
      ctx.reply(ctx.t('bot.login.phoneSaved'), {
        ...HTML,
        reply_markup: { remove_keyboard: true },
      }),
    );
    // Only now that the code reached the user: a failed send must not leave a number behind.
    // A failure here must not stop the login (the code is out), so only the error name is logged.
    try {
      await deps.users.setPhone(ctx.user.id, phone);
    } catch (error) {
      deps.log.warn(`phone not saved: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  });

  bot.callbackQuery(DENY_CALLBACK, async (ctx) => {
    const nonce = ctx.match[1];
    let result: DenyResult = 'expired';
    try {
      if (nonce !== undefined) {
        result = await deps.login.deny({
          nonce,
          telegramId: BigInt(ctx.from.id),
          now: deps.clock.now(),
        });
      }
      // Editing replaces the message, so the code leaves the chat too.
      if (result !== 'expired') {
        const key = result === 'sessionEnded' ? 'bot.login.sessionEnded' : 'bot.login.denied';
        await ctx.editMessageText(ctx.t(key), { ...HTML, reply_markup: { inline_keyboard: [] } });
      }
    } catch (error) {
      deps.log.warn(`login deny failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    try {
      await ctx.answerCallbackQuery(
        result === 'expired' ? { text: ctx.t('bot.login.expired') } : {},
      );
    } catch {
      // The spinner is cosmetic; never throw out of a callback handler.
    }
  });
}
