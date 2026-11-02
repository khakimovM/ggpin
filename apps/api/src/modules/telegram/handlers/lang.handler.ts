import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';
import { languageKeyboard, parseLangCallback, startKeyboard } from '../keyboards';

export function registerLang(bot: TelegramBot, deps: BotDeps): void {
  bot.command('lang', async (ctx) => {
    await ctx.reply(ctx.t('bot.lang.prompt'), {
      parse_mode: 'HTML',
      reply_markup: languageKeyboard(ctx),
    });
  });

  bot.callbackQuery(/^lang:/, async (ctx) => {
    try {
      const choice = parseLangCallback(ctx.callbackQuery.data);
      if (choice === null) return;
      if (choice.kind === 'menu') {
        await ctx.reply(ctx.t('bot.lang.prompt'), {
          parse_mode: 'HTML',
          reply_markup: languageKeyboard(ctx),
        });
        return;
      }
      const me = await deps.users.updateLocale(ctx.user.id, choice.locale);
      ctx.locale = me.locale;
      await ctx.reply(ctx.t('bot.lang.changed'), {
        parse_mode: 'HTML',
        reply_markup: startKeyboard(ctx, deps.config),
      });
      if (ctx.chat !== undefined) await deps.menu.setForChat(ctx.chat.id, ctx.locale);
    } finally {
      await ctx.answerCallbackQuery();
    }
  });
}
