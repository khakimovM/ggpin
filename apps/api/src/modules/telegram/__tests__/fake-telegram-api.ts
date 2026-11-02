import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { TEST_BOT_TOKEN, TEST_BOT_USERNAME } from '../../../config/__tests__/test-env';
import type { BotContext } from '../bot-context';

export interface RecordedCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export interface FakeTelegram {
  readonly bot: Bot<BotContext>;
  /** Every Bot API call the code under test made, in order. */
  readonly calls: RecordedCall[];
  /** Makes the next calls to `method` fail with a Bot API error (400) instead of succeeding. */
  failMethod(method: string): void;
  callsOf(method: string): RecordedCall[];
}

const BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'test bot',
  username: TEST_BOT_USERNAME,
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function fakeResult(method: string, payload: Record<string, unknown>): unknown {
  if (method === 'sendMessage') {
    return {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: payload['chat_id'], type: 'private' },
      text: payload['text'],
    };
  }
  if (method === 'getMe') return BOT_INFO;
  return true;
}

// A Bot whose API layer is replaced by a recorder: the transformer never calls `prev`, so no
// request leaves the process. As a second barrier the API root points at a reserved,
// unroutable host, and `botInfo` is preset so grammY never calls getMe.
export function createFakeTelegram(): FakeTelegram {
  const calls: RecordedCall[] = [];
  const failing = new Set<string>();
  const bot = new Bot<BotContext>(TEST_BOT_TOKEN, {
    botInfo: BOT_INFO,
    client: { apiRoot: 'http://telegram.invalid' },
  });
  bot.api.config.use((_prev, method, payload) => {
    // JSON round-trip: drops undefined keys and turns InlineKeyboard into the plain wire shape.
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    calls.push({ method, payload: body });
    const response = failing.has(method)
      ? { ok: false, error_code: 400, description: 'Bad Request: fake failure' }
      : { ok: true, result: fakeResult(method, body) };
    // The recorder answers for every method, so the generic result type cannot be narrowed.
    return Promise.resolve(response as never);
  });
  return {
    bot,
    calls,
    failMethod: (method) => failing.add(method),
    callsOf: (method) => calls.filter((c) => c.method === method),
  };
}
