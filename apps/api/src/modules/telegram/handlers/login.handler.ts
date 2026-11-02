import type { IssueCodeFailure } from '../../auth/otp-login.service';
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

// The only place a plain code exists: it goes straight into this reply and nowhere else.
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
  await ctx.reply(ctx.t('bot.login.code', { code: result.code }), {
    ...HTML,
    protect_content: true,
    reply_markup: denyKeyboard(ctx, nonce),
  });
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
    await deps.users.setPhone(ctx.user.id, phone);
    // One message carries one reply_markup, so the keyboard goes away with a short
    // confirmation and the code arrives as its own message with the inline button.
    await ctx.reply(ctx.t('bot.login.phoneSaved'), {
      ...HTML,
      reply_markup: { remove_keyboard: true },
    });
    await issueAndReply(ctx, deps, nonce);
  });

  bot.callbackQuery(DENY_CALLBACK, async (ctx) => {
    const nonce = ctx.match[1];
    let denied = false;
    try {
      denied =
        nonce !== undefined &&
        (await deps.login.deny({
          nonce,
          telegramId: BigInt(ctx.from.id),
          now: deps.clock.now(),
        }));
      // Editing replaces the message, so the code leaves the chat too.
      if (denied) {
        await ctx.editMessageText(ctx.t('bot.login.denied'), {
          ...HTML,
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch (error) {
      deps.log.warn(`login deny failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    try {
      await ctx.answerCallbackQuery(denied ? {} : { text: ctx.t('bot.login.expired') });
    } catch {
      // The spinner is cosmetic; never throw out of a callback handler.
    }
  });
}
