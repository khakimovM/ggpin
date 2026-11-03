import type { Update } from 'grammy/types';
import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, myChatMemberUpdate, textUpdate } from './updates';

const ID = 700_501;
const OTHER = 700_502;

// A private chat whose id is not the sender's: no real client can produce this.
function forged(update: Update, chatId: number): Update {
  const copy = JSON.parse(JSON.stringify(update)) as Update;
  if (copy.message !== undefined) copy.message.chat.id = chatId;
  if (copy.callback_query?.message !== undefined) copy.callback_query.message.chat.id = chatId;
  if (copy.my_chat_member !== undefined) copy.my_chat_member.chat.id = chatId;
  return copy;
}

describe('business connection guard', () => {
  it('drops a message that came through a business connection: no handler, no reply', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    const update = textUpdate({ id: ID }, '/start');
    if (update.message !== undefined) update.message.business_connection_id = 'bc-1';
    await h.send(update);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.warn).toEqual(['update dropped: business connection']);
  });
});

describe('private chat / sender guard', () => {
  it.each([
    ['message', textUpdate({ id: ID }, '/start')],
    ['callback_query', callbackUpdate({ id: ID }, 'help')],
    ['my_chat_member', myChatMemberUpdate({ id: ID }, 'kicked')],
  ])('drops a forged %s: no handler, no reply, one id-free warning', async (_n, update) => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(forged(update, OTHER));
    expect(h.calls).toHaveLength(0);
    expect(h.store.get(BigInt(ID))?.botBlockedAt).toBeNull();
    expect(h.store.has(BigInt(OTHER))).toBe(false);
    expect(h.logs.warn).toEqual(['update dropped: private chat/from mismatch']);
  });

  it.each([
    ['message', textUpdate({ id: ID }, '/help'), 'sendMessage'],
    ['callback_query', callbackUpdate({ id: ID }, 'help'), 'answerCallbackQuery'],
  ])('lets a genuine %s through', async (_n, update, method) => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(update);
    expect(h.callsOf(method).length).toBeGreaterThan(0);
    expect(h.logs.warn).toEqual([]);
  });

  it('lets genuine my_chat_member updates through (kicked, then member)', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(myChatMemberUpdate({ id: ID }, 'kicked'));
    expect(h.store.get(BigInt(ID))?.botBlockedAt).not.toBeNull();
    await h.send(myChatMemberUpdate({ id: ID }, 'member'));
    expect(h.store.get(BigInt(ID))?.botBlockedAt).toBeNull();
    expect(h.logs.warn).toEqual([]);
  });

  it('passes a callback_query that has no message (no chat to compare)', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    const update = callbackUpdate({ id: ID }, 'help');
    if (update.callback_query !== undefined) delete update.callback_query.message;
    await h.send(update);
    expect(h.logs.warn).toEqual([]);
  });
});
