import type { TelegramBot } from '../bot.provider';
import { CB_HELP } from '../keyboards';

export function registerHelp(bot: TelegramBot): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(ctx.t('bot.help.text'), { parse_mode: 'HTML' });
  });
  bot.callbackQuery(CB_HELP, async (ctx) => {
    try {
      await ctx.reply(ctx.t('bot.help.text'), { parse_mode: 'HTML' });
    } finally {
      await ctx.answerCallbackQuery();
    }
  });
}
