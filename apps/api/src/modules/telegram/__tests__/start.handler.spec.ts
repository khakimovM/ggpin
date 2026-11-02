import { createHarness, makeUser } from './bot-harness';
import { textUpdate } from './updates';

const ID = 700_001;

describe('/start', () => {
  it('a user created by this /start gets the bilingual language picker', async () => {
    const h = createHarness();
    await h.send(textUpdate({ id: ID, language_code: 'ru' }, '/start'));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.callsOf('sendMessage')).toHaveLength(1);
  });

  it.each(['uz', 'ru'] as const)('an existing %s user gets the welcome', async (locale) => {
    const h = createHarness({ users: [makeUser(BigInt(ID), { locale })] });
    await h.send(textUpdate({ id: ID, language_code: locale, first_name: 'Ann' }, '/start'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('passes the referral code to user creation only for /start ref_<code>', async () => {
    const h = createHarness();
    await h.send(textUpdate({ id: ID }, '/start ref_abcd1234'));
    await h.send(textUpdate({ id: ID + 1 }, '/start p_some-product'));
    await h.send(textUpdate({ id: ID + 2 }, '/start'));
    expect(h.refCodes).toEqual(['abcd1234', undefined, undefined]);
  });

  it('p_<slug> and login_<nonce> behave like a plain /start', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(textUpdate({ id: ID }, '/start'));
    await h.send(textUpdate({ id: ID }, '/start p_some-product'));
    await h.send(textUpdate({ id: ID }, `/start login_${'a'.repeat(43)}`));
    const texts = h.callsOf('sendMessage').map((c) => c.payload['text']);
    expect(texts).toHaveLength(3);
    expect(new Set(texts).size).toBe(1);
  });

  it('admin_<nonce> answers "link expired" to everyone', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID), { locale: 'ru' })] });
    await h.send(textUpdate({ id: ID }, `/start admin_${'b'.repeat(43)}`));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('escapes HTML in first_name', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(textUpdate({ id: ID, first_name: '<b>&' }, '/start'));
    const text = String(h.callsOf('sendMessage')[0]?.payload['text']);
    expect(text).toContain('&lt;b&gt;&amp;');
    expect(text).not.toContain('<b>');
  });

  it('clears botBlockedAt', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID), { botBlockedAt: new Date() })] });
    await h.send(textUpdate({ id: ID }, '/start'));
    expect(h.store.get(BigInt(ID))?.botBlockedAt).toBeNull();
  });

  it('omits the shop button without MINI_APP_URL and adds news only when configured', async () => {
    const h = createHarness({
      users: [makeUser(BigInt(ID))],
      config: { MINI_APP_URL: undefined, TELEGRAM_NEWS_CHANNEL_URL: 'https://t.me/news_test' },
    });
    await h.send(textUpdate({ id: ID }, '/start'));
    const markup = JSON.stringify(h.callsOf('sendMessage')[0]?.payload['reply_markup']);
    expect(markup).not.toContain('web_app');
    expect(markup).toContain('https://t.me/news_test');
    expect(h.callsOf('setChatMenuButton')).toHaveLength(0);
  });

  it('a blocked user gets only the blocked notice', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID), { isBlocked: true })] });
    await h.send(textUpdate({ id: ID }, '/start'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('ignores group chats', async () => {
    const h = createHarness();
    const update = textUpdate({ id: ID }, '/start');
    if (update.message) update.message.chat = { id: -5, type: 'group', title: 'g' };
    await h.send(update);
    expect(h.calls).toHaveLength(0);
    expect(h.store.size).toBe(0);
  });
});
