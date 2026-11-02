import type { BotDeps } from './bot-deps';
import type { TelegramBot } from './bot.provider';
import { registerChatMember } from './handlers/chat-member.handler';
import { registerHelp } from './handlers/help.handler';
import { registerLang } from './handlers/lang.handler';
import { registerLogin } from './handlers/login.handler';
import { registerRef } from './handlers/ref.handler';
import { registerShop } from './handlers/shop.handler';
import { registerStart } from './handlers/start.handler';
import { userContext } from './middleware/user-context.middleware';
import { safeErrorText } from './safe-error';

// The single place the middleware order is decided. Shared by the Nest wiring and the unit
// tests, so tests exercise the exact stack that ships.
export function installHandlers(bot: TelegramBot, deps: BotDeps): void {
  // Without a catch, grammY rethrows handler errors out of handleUpdate. Logged without the
  // update (it holds the user's messages) and swallowed so Telegram gets its 200.
  bot.catch((err) => {
    deps.log.error(`update ${err.ctx.update.update_id} failed: ${safeErrorText(err.error)}`);
  });

  registerChatMember(bot, deps);
  bot.use(userContext(deps));
  registerStart(bot, deps);
  registerLang(bot, deps);
  registerLogin(bot, deps);
  registerHelp(bot);
  registerRef(bot, deps);
  registerShop(bot, deps);
}
