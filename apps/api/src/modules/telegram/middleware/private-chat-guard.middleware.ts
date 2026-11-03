import type { Middleware } from 'grammy';
import type { BotContext } from '../bot-context';
import type { BotLogger } from '../bot-deps';

/**
 * In a private chat the chat id IS the user id. An update that says otherwise is forged or
 * corrupt (the webhook secret is the first line of defence): drop it silently, run no handler.
 * Updates that arrive through a Telegram Business connection are dropped too: the bot has no
 * business features, and a reply to one would land in the BUSINESS OWNER's chat with their
 * customer (a login code could be sent to the wrong person). Callback queries carry their chat in `message.chat`; ones without a message have no chat
 * and pass (the user-context middleware stops those).
 */
export function privateChatGuard(log: BotLogger): Middleware<BotContext> {
  return async (ctx, next) => {
    const { chat, from } = ctx;
    if (ctx.businessConnectionId !== undefined) {
      log.warn('update dropped: business connection');
      return;
    }
    if (chat?.type === 'private' && from !== undefined && chat.id !== from.id) {
      log.warn('update dropped: private chat/from mismatch');
      return;
    }
    await next();
  };
}
