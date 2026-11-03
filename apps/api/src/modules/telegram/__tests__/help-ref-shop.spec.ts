import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, textUpdate } from './updates';

const ID = 700_201;

describe.each(['uz', 'ru'] as const)('help, ref and shop (%s)', (locale) => {
  const users = [makeUser(BigInt(ID), { locale, referralCode: 'xyz98765' })];

  it('/help', async () => {
    const h = createHarness({ users });
    await h.send(textUpdate({ id: ID }, '/help'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('the help button answers with the help text and closes the spinner', async () => {
    const h = createHarness({ users });
    await h.send(callbackUpdate({ id: ID }, 'help'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('/ref sends the t.me link with the user referral code', async () => {
    const h = createHarness({ users });
    await h.send(textUpdate({ id: ID }, '/ref'));
    expect(String(h.callsOf('sendMessage')[0]?.payload['text'])).toContain(
      'https://t.me/ggpin_test_bot?start=ref_xyz98765',
    );
    expect(h.payloads()).toMatchSnapshot();
  });

  it('/shop with the Mini App URL', async () => {
    const h = createHarness({ users });
    await h.send(textUpdate({ id: ID }, '/shop'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it('/shop without MINI_APP_URL has no web_app button', async () => {
    const h = createHarness({ users, config: { MINI_APP_URL: undefined } });
    await h.send(textUpdate({ id: ID }, '/shop'));
    expect(JSON.stringify(h.calls)).not.toContain('web_app');
    expect(h.payloads()).toMatchSnapshot();
  });
});
