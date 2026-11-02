import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';
import { shopKeyboard } from '../keyboards';

export function registerShop(bot: TelegramBot, deps: BotDeps): void {
  bot.command('shop', async (ctx) => {
    const keyboard = shopKeyboard(ctx, deps.config);
    if (keyboard === undefined) {
      await ctx.reply(ctx.t('bot.shop.unavailable'), { parse_mode: 'HTML' });
      return;
    }
    await ctx.reply(ctx.t('bot.shop.open'), { parse_mode: 'HTML', reply_markup: keyboard });
  });
}
