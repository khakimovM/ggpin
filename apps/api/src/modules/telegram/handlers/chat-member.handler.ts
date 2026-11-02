import type { BotDeps } from '../bot-deps';
import type { TelegramBot } from '../bot.provider';

// Runs before the user-context middleware: it only needs the telegram id, must never create
// a user, and must not reply to someone who just blocked us. `isBlocked` (admin block) is not
// touched; this only records whether notifications can be delivered (botBlockedAt).
export function registerChatMember(bot: TelegramBot, deps: BotDeps): void {
  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member: member, from } = ctx.myChatMember;
    if (chat.type !== 'private') return;
    const telegramId = BigInt(from.id);
    if (member.status === 'kicked') {
      await deps.users.markBotBlocked(telegramId, deps.clock.now());
    } else if (member.status === 'member') {
      await deps.users.clearBotBlocked(telegramId);
    }
  });
}
