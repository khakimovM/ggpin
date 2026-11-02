import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';

export function registerRef(bot: TelegramBot, deps: BotDeps): void {
  bot.command('ref', async (ctx) => {
    const link = `https://t.me/${deps.config.TELEGRAM_BOT_USERNAME}?start=ref_${ctx.user.referralCode}`;
    await ctx.reply(ctx.t('bot.ref.link', { link }), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });
}
