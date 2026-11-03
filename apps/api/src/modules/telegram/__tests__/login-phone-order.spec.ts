import { BotError } from 'grammy';
import { createHarness, makeUser } from './bot-harness';
import { contactUpdate, textUpdate } from './updates';

const ID = 700_301;
const NONCE = 'n'.repeat(43);
const START = `/start login_${NONCE}`;
const noPhone = (locale: 'uz' | 'ru' = 'uz'): ReturnType<typeof makeUser>[] => [
  makeUser(BigInt(ID), { locale }),
];

describe('contact message: the phone is stored only after the code was delivered', () => {
  const OWN = { phone_number: '998901234567', user_id: ID };
  const start = async (
    options: Parameters<typeof createHarness>[0] = {},
  ): Promise<ReturnType<typeof createHarness>> => {
    const h = createHarness({ users: noPhone('ru'), ...options });
    await h.send(textUpdate({ id: ID }, START));
    h.calls.length = 0;
    return h;
  };

  it('the code message fails: no phone is stored and the code is released', async () => {
    const h = await start();
    h.failNthCall('sendMessage', 2); // 1 = "phone saved", 2 = the code
    await expect(h.send(contactUpdate({ id: ID }, OWN))).rejects.toBeInstanceOf(BotError);
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    expect(h.releaseCalls).toEqual([{ nonce: NONCE, telegramId: BigInt(ID), code: '482913' }]);
  });

  it('the "phone saved" message fails before the code goes out: code released, no phone', async () => {
    const h = await start();
    h.failNthCall('sendMessage', 1);
    await expect(h.send(contactUpdate({ id: ID }, OWN))).rejects.toBeInstanceOf(BotError);
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    expect(h.releaseCalls).toHaveLength(1);
    expect(h.callsOf('sendMessage')).toHaveLength(1); // the code was never sent
  });

  it('a failing setPhone after delivery does not stop the login and logs the error name only', async () => {
    const h = await start({
      usersOverride: { setPhone: () => Promise.reject(new TypeError('db down +998901234567')) },
    });
    await h.send(contactUpdate({ id: ID }, OWN));
    expect(h.callsOf('sendMessage')).toHaveLength(2);
    expect(h.releaseCalls).toHaveLength(0);
    expect(h.logs.warn).toEqual(['phone not saved: TypeError']);
    expect(JSON.stringify(h.logs)).not.toContain('998901234567');
  });
});
