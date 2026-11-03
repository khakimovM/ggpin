import { SESSION_END_CALLBACK_PREFIX } from '@repo/shared';
import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';

const HTML = { parse_mode: 'HTML' } as const;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const SESSION_END_CALLBACK = new RegExp(`^${SESSION_END_CALLBACK_PREFIX}(${UUID})$`);

/** The "this was not me" button of the new-login notice: ends that web session. */
export function registerSession(bot: TelegramBot, deps: BotDeps): void {
  bot.callbackQuery(SESSION_END_CALLBACK, async (ctx) => {
    const familyId = ctx.match[1];
    let answer: { text: string } | undefined;
    try {
      const ended =
        familyId !== undefined &&
        (await deps.sessions.endSessionFromBot({
          telegramId: BigInt(ctx.from.id),
          familyId,
          now: deps.clock.now(),
        }));
      if (ended) {
        await ctx.editMessageText(ctx.t('bot.session.ended'), {
          ...HTML,
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        answer = { text: ctx.t('bot.session.alreadyEnded') };
        // A stale button must not stay pressable.
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      }
    } catch (error) {
      deps.log.warn(`session end failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    try {
      await ctx.answerCallbackQuery(answer ?? {});
    } catch {
      // The spinner is cosmetic; never throw out of a callback handler.
    }
  });
}
