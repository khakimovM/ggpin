import { createFakeTelegram } from '../../telegram/__tests__/fake-telegram-api';
import { callbackUpdate, textUpdate } from '../../telegram/__tests__/updates';
import { maskTelegramId } from '../admins/admin-allowlist';
import { ADMIN_BASE } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

// The bot half of the admin login through the real webhook and the real wiring
// (BotHandlersService -> AdminLoginService); only the Bot API transport is fake.
describe('admin login through the bot (real app, fake Bot API)', () => {
  const fake = createFakeTelegram();
  const t = useAdminE2e({ bot: fake });
  const messagesTo = (chatId: number) =>
    fake.callsOf('sendMessage').filter((c) => c.payload['chat_id'] === chatId);
  const textsTo = (chatId: number) => messagesTo(chatId).map((c) => String(c.payload['text']));
  const codeOf = (text: string | undefined) => /<code>(\d{6})<\/code>/.exec(text ?? '')?.[1];
  const statusOf = async (nonce: string): Promise<string> =>
    (await t.request('GET', `${ADMIN_BASE}/status/${nonce}`, t.spa())).json<{
      data: { status: string };
    }>().data.status;

  it('an allowlisted, active admin gets a protected code with the warning and the deny button', async () => {
    const admin = await t.newAdmin('OWNER');
    const id = Number(admin.telegramId);
    const ip = t.nextIp();
    const nonce = await t.start(ip);
    expect((await t.webhook(textUpdate({ id }, `/start admin_${nonce}`))).statusCode).toBe(200);

    const [message] = messagesTo(id);
    const text = String(message?.payload['text']);
    const code = codeOf(text);
    expect(code).toMatch(/^\d{6}$/);
    expect(message?.payload['protect_content']).toBe(true);
    expect(text).toContain(new URL(t.env.ADMIN_URL).host); // SA-L4: where to type it
    expect(text).toContain(ip.replace(/\.\d+$/, '.x')); // where the login was started, masked
    expect(text).not.toContain(ip);
    expect(JSON.stringify(message?.payload['reply_markup'])).toContain(`"ad:${nonce}"`);
    expect(await statusOf(nonce)).toBe('CODE_SENT');

    // A second /start with the same link: no second code.
    await t.webhook(textUpdate({ id }, `/start admin_${nonce}`));
    expect(textsTo(id)).toHaveLength(2);
    expect(codeOf(textsTo(id)[1])).toBeUndefined();

    const verified = await t.verify(nonce, code ?? '');
    expect(verified.statusCode).toBe(200);
  });

  it.each([
    ['not in ADMIN_TELEGRAM_IDS', { allowlisted: false, active: true }],
    ['inactive', { allowlisted: true, active: false }],
  ])('%s: the dead-link answer, no code, the request stays PENDING', async (_name, opts) => {
    const admin = await t.newAdmin('OWNER', opts);
    const id = Number(admin.telegramId);
    const nonce = await t.start();
    await t.webhook(textUpdate({ id }, `/start admin_${nonce}`));
    const texts = textsTo(id);
    expect(texts).toHaveLength(1);
    expect(codeOf(texts[0])).toBeUndefined();
    expect(texts[0]).toBe('⌛ Havola eskirgan. Qaytadan urinib ko‘ring.');
    expect(await statusOf(nonce)).toBe('PENDING');
  });

  it('a refused account: 10 tries write ONE ADMIN_CODE_REFUSED warn line (S2-m3), masked', async () => {
    const outsider = await t.newAdmin('OWNER', { allowlisted: false });
    const id = Number(outsider.telegramId);
    for (let i = 0; i < 10; i += 1) {
      await t.webhook(textUpdate({ id }, `/start admin_${await t.start()}`));
    }
    expect(textsTo(id)).toHaveLength(10); // every try still gets the dead-link answer
    const line = `event=ADMIN_CODE_REFUSED telegramId=${maskTelegramId(outsider.telegramId)}`;
    const refused = t.logs
      .text()
      .split('\n')
      .filter((l) => l.includes(line));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"level":"warn"');
    expect(t.logs.text()).not.toContain(String(id));
  });

  it('5 codes per account per 10 minutes; the 6th is refused (no code, PENDING, one K3 log line)', async () => {
    const admin = await t.newAdmin('OWNER');
    const id = Number(admin.telegramId);
    for (let i = 0; i < 5; i += 1) {
      await t.webhook(textUpdate({ id }, `/start admin_${await t.start()}`));
    }
    expect(textsTo(id).filter((text) => codeOf(text) !== undefined)).toHaveLength(5);
    const sixth = await t.start();
    await t.webhook(textUpdate({ id }, `/start admin_${sixth}`));
    expect(textsTo(id).at(-1)).toBe(
      '⏳ Juda ko‘p kod so‘raldi. Bir necha daqiqadan keyin qayta urinib ko‘ring.',
    );
    expect(await statusOf(sixth)).toBe('PENDING');
    const masked = `${String(id).slice(0, 2)}${'*'.repeat(String(id).length - 4)}${String(id).slice(-2)}`;
    const quota = t.logs
      .text()
      .split('\n')
      .filter((l) => l.includes(`event=ADMIN_CODE_QUOTA_EXHAUSTED telegramId=${masked}`));
    expect(quota).toHaveLength(1);
    expect(t.logs.text()).not.toContain(String(id));

    t.clock.advanceSec(10 * 60 + 1); // the window has moved on
    const later = await t.start();
    await t.webhook(textUpdate({ id }, `/start admin_${later}`));
    expect(codeOf(textsTo(id).at(-1))).toMatch(/^\d{6}$/);
  });

  it('«Bu men emasman» (ad:<nonce>): DENIED, the message is edited, the code is dead', async () => {
    const admin = await t.newAdmin('OPERATOR');
    const id = Number(admin.telegramId);
    const nonce = await t.start();
    await t.webhook(textUpdate({ id }, `/start admin_${nonce}`));
    const code = codeOf(textsTo(id)[0]);

    await t.webhook(callbackUpdate({ id }, `ad:${nonce}`));
    expect(await statusOf(nonce)).toBe('DENIED');
    const edits = fake.callsOf('editMessageText').filter((c) => c.payload['chat_id'] === id);
    expect(edits.map((c) => String(c.payload['text']))).toEqual([
      '🚫 Admin paneliga kirish bekor qilindi. Kod endi ishlamaydi.',
    ]);
    const late = await t.verify(nonce, code ?? '');
    expect(late.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
  });
});
