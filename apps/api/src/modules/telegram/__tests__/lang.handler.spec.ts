import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, textUpdate } from './updates';

const ID = 700_101;

describe('/lang', () => {
  it('shows the picker', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(textUpdate({ id: ID }, '/lang'));
    expect(h.payloads()).toMatchSnapshot();
  });

  it.each(['uz', 'ru'] as const)('lang:%s saves the locale and confirms in it', async (locale) => {
    const other = locale === 'uz' ? 'ru' : 'uz';
    const h = createHarness({ users: [makeUser(BigInt(ID), { locale: other })] });
    await h.send(callbackUpdate({ id: ID }, `lang:${locale}`));
    expect(h.store.get(BigInt(ID))?.locale).toBe(locale);
    expect(h.payloads()).toMatchSnapshot();
    expect(h.calls.at(-1)?.method).toBe('answerCallbackQuery');
  });

  it('rejects unknown callback data without changing anything', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(callbackUpdate({ id: ID }, 'lang:en'));
    await h.send(callbackUpdate({ id: ID }, 'lang:uz;DROP'));
    expect(h.store.get(BigInt(ID))?.locale).toBe('uz');
    expect(h.callsOf('sendMessage')).toHaveLength(0);
    expect(h.callsOf('answerCallbackQuery')).toHaveLength(2);
  });

  it('the language button opens the picker', async () => {
    const h = createHarness({ users: [makeUser(BigInt(ID))] });
    await h.send(callbackUpdate({ id: ID }, 'lang:menu'));
    expect(h.callsOf('sendMessage')).toHaveLength(1);
  });
});
