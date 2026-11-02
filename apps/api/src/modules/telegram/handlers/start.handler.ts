import { parseStartPayload } from '@repo/shared';
import type { BotContext } from '../bot-context';
import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';
import { handleLoginStart } from './login.handler';
import { languageKeyboard, startKeyboard } from '../keyboards';

export function registerStart(bot: TelegramBot, deps: BotDeps): void {
  bot.command('start', async (ctx) => {
    // A user who blocked and then restarted the bot can receive notifications again.
    if (ctx.user.botBlockedAt !== null) await deps.users.clearBotBlocked(ctx.user.telegramId);

    const payload = parseStartPayload(ctx.match);
    switch (payload.kind) {
      case 'admin':
        // Admin login ships in phase 9; until then the link is dead for everyone.
        await ctx.reply(ctx.t('bot.admin.linkExpired'), { parse_mode: 'HTML' });
        return;
      case 'login':
        await handleLoginStart(ctx, deps, payload.nonce);
        return;
      case 'ref': // already bound by the user-context middleware (new users only)
      case 'product': // p_<slug> behaves like a plain /start until product deep links exist
      case 'none':
        break;
    }

    if (ctx.created) {
      await ctx.reply(ctx.t('bot.lang.prompt'), {
        parse_mode: 'HTML',
        reply_markup: languageKeyboard(ctx),
      });
    } else {
      await sendWelcome(ctx, deps);
    }
    await deps.menu.setForChat(ctx.chat.id, ctx.locale);
  });
}

export async function sendWelcome(ctx: BotContext, deps: BotDeps): Promise<void> {
  await ctx.reply(ctx.t('bot.start.welcome', { name: ctx.from?.first_name ?? '' }), {
    parse_mode: 'HTML',
    reply_markup: startKeyboard(ctx, deps.config),
  });
}
