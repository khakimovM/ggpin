// Phase 4 S0 spike: bot-sent messages (sender.isBot) and inline "via bot" messages. Never merged to main.
import type { Message, TelegramClient } from '@mtcute/node';
import { randomLong } from '@mtcute/node/utils.js';
import { checkHistory, describeMessage } from './spike-messages';
import { errCode, out, waiter } from './spike-util';

// Public inline bots that exist on the production DC; on the test DC they may not exist.
const INLINE_CANDIDATES = ['gif', 'pic', 'bold', 'wiki', 'vid', 'bing', 'imdb', 'sticker'];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export async function tryViaBot(
  a: TelegramClient,
  peerB: number,
  expect: (pred: (m: Message) => boolean) => Promise<Message | null>,
): Promise<Message | null> {
  const peer = await a.resolvePeer(peerB);
  for (const name of INLINE_CANDIDATES) {
    try {
      const bot = await a.resolveUser(name);
      const res = await withTimeout(
        a.call({ _: 'messages.getInlineBotResults', bot, peer, query: 'cat', offset: '' }),
        15_000,
      );
      const first = res?.results[0];
      if (!res || !first) {
        out(`via.${name}`, `const:no-results`);
        continue;
      }
      const got = expect((m) => m.viaBot !== null);
      await a.call({
        _: 'messages.sendInlineBotResult',
        peer,
        randomId: randomLong(),
        queryId: res.queryId,
        id: first.id,
      });
      const msg = await got;
      out(`via.${name}.received`, msg !== null);
      if (msg) return msg;
    } catch (e) {
      out(`via.${name}`, `const:${errCode(e)}`);
    }
  }
  out('via.produced', false);
  return null;
}

export async function tryBotFather(a: TelegramClient): Promise<void> {
  try {
    const bf = await a.getUser('BotFather');
    out('bot.BotFather.resolved', true);
    out('bot.BotFather.isBot', bf.isBot);
    const w = waiter<Message>((m) => m.sender.id === bf.id && !m.isOutgoing, 20_000);
    const listener = (m: Message): void => w.push(m);
    a.onNewMessage.add(listener);
    const sent = await a.sendText('BotFather', '/start');
    const reply = await w.promise;
    a.onNewMessage.remove(listener);
    out('bot.reply.received', reply !== null);
    if (!reply) return;
    describeMessage('bot.reply', reply, bf.id, bf.id);
    const hist = await checkHistory('hist.AwithBotFather', a, bf.id, [sent.id, reply.id]);
    out(
      'hist.AwithBotFather.containsOwnOutgoing',
      hist.some((m) => m.id === sent.id && m.isOutgoing),
    );
    out(
      'hist.AwithBotFather.botMessagesHaveIsBot',
      hist.filter((m) => !m.isOutgoing).every((m) => m.sender.type === 'user' && m.sender.isBot),
    );
  } catch (e) {
    out('bot.BotFather.error', `const:${errCode(e)}`);
  }
}
