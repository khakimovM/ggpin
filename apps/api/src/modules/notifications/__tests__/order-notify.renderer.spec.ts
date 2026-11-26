import { Logger } from '@nestjs/common';
import { ORDER_NOTIFY_KINDS, tgOutboxJobSchema, type OrderNotifyKind } from '@repo/shared';
import { OrderSourceMissingError, type OrderNotifyResult } from '../order-notify.renderer';
import { norm, orderRenderer, orderRow } from './order-notify.test-fixtures';

// The row each kind is true for (accepted: just paid; delivered: has deliveredAt; review: held;
// refunded: REFUNDED with its REFUND entry).
const ROW_FOR: Readonly<Record<OrderNotifyKind, Parameters<typeof orderRow>[0]>> = {
  ORDER_ACCEPTED: { status: 'PAID' },
  ORDER_DELIVERED: { status: 'DELIVERED', deliveredAt: new Date('2030-01-01T09:00:00Z') },
  ORDER_REVIEW: { status: 'HELD', statusReason: 'LOW_BALANCE' },
  ORDER_REFUNDED: { status: 'REFUNDED', statusReason: 'HELD_EXPIRED' },
};
const REFUND = { amountTiyin: 12_345_600n };

function message(result: OrderNotifyResult) {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.kind}`);
  return tgOutboxJobSchema.parse(result.job);
}

describe('order messages (bot.order.*)', () => {
  const cases = ORDER_NOTIFY_KINDS.flatMap((kind) =>
    (['uz', 'ru'] as const).map((l) => [kind, l] as const),
  );

  it.each(cases)('%s in %s', async (kind, locale) => {
    const row = orderRow({ ...ROW_FOR[kind], user: { ...orderRow().user, locale } });
    const renderer = orderRenderer({
      order: () => Promise.resolve(row),
      orderRefund: () => Promise.resolve(REFUND),
    });
    const job = message(await renderer.render(kind, 'cmorder1'));
    expect(job.chatId).toBe('777000111');
    expect(job.replyMarkup).toEqual({
      inline_keyboard: [
        [
          {
            text: locale === 'uz' ? 'Buyurtmani ko‘rish' : 'Посмотреть заказ',
            web_app: { url: 'https://app.ggpin.test/tg/orders/cmorder1' },
          },
        ],
      ],
    });
    expect(norm(job)).toMatchSnapshot();
  });

  it('HTML-escapes the recipient name, username and product name (S2 audit I7)', async () => {
    const row = orderRow({
      recipient: { username: 'a<b>c', displayName: '<b>Boss</b> & co' },
      product: { nameUz: '<i>Stars</i>', nameRu: '<i>Stars</i>' },
    });
    const renderer = orderRenderer({ order: () => Promise.resolve(row) });
    const { text } = message(await renderer.render('ORDER_ACCEPTED', 'cmorder1'));
    expect(text).toContain(
      '<code>&lt;b&gt;Boss&lt;/b&gt; &amp; co</code> (<code>@a&lt;b&gt;c</code>)',
    );
    expect(text).toContain('&lt;i&gt;Stars&lt;/i&gt;');
    expect(text).not.toMatch(/<b>|<i>/);
  });

  it('prints the pack label, or "× N" for a free quantity, or the bare name', async () => {
    const texts: string[] = [];
    for (const over of [
      { sku: { labelUz: '3 oylik', labelRu: '3 месяца' }, quantity: 3 },
      { sku: null, quantity: 500 },
      { sku: null, quantity: 1 },
    ]) {
      const renderer = orderRenderer({ order: () => Promise.resolve(orderRow(over)) });
      texts.push(message(await renderer.render('ORDER_ACCEPTED', 'cmorder1')).text);
    }
    expect(texts[0]).toContain('Telegram Stars (3 oylik)');
    expect(texts[1]).toContain('Telegram Stars × 500');
    expect(texts[2]).toContain(': Telegram Stars → ');
  });

  it('shows only @username when the name is the username, a dash for a broken row', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const one = orderRenderer({
      order: () => Promise.resolve(orderRow({ recipient: { username: 'solo_user' } })),
    });
    expect(message(await one.render('ORDER_ACCEPTED', 'o')).text).toContain('→ @solo_user');
    const broken = orderRenderer({
      order: () => Promise.resolve(orderRow({ recipient: { displayName: '' } })),
    });
    expect(message(await broken.render('ORDER_ACCEPTED', 'o')).text).toMatch(/→ —$/);
    expect(warn).toHaveBeenCalledWith(
      'order cmorder1 stores a recipient without a name or username',
    );
    warn.mockRestore();
  });

  it.each(ORDER_NOTIFY_KINDS)('%s: nothing for a user who blocked the bot', async (kind) => {
    const row = orderRow({
      ...ROW_FOR[kind],
      user: { ...orderRow().user, botBlockedAt: new Date() },
    });
    const renderer = orderRenderer({
      order: () => Promise.resolve(row),
      orderRefund: () => Promise.resolve(REFUND),
    });
    await expect(renderer.render(kind, 'cmorder1')).resolves.toEqual({ kind: 'skipped-blocked' });
  });

  it.each([
    ['ORDER_ACCEPTED', { status: 'DELIVERED', deliveredAt: new Date() }],
    ['ORDER_REVIEW', { status: 'REFUNDED' }],
    ['ORDER_DELIVERED', { status: 'PROCESSING' }],
    ['ORDER_REFUNDED', { status: 'FAILED' }],
  ] as const)('%s is not sent once the order is no longer that (%j)', async (kind, over) => {
    const renderer = orderRenderer({
      order: () => Promise.resolve(orderRow(over)),
      orderRefund: () => Promise.resolve(REFUND),
    });
    await expect(renderer.render(kind, 'cmorder1')).resolves.toEqual({ kind: 'skipped-stale' });
  });

  it('a REFUNDED order without its REFUND entry is not announced as refunded', async () => {
    const renderer = orderRenderer({
      order: () => Promise.resolve(orderRow({ status: 'REFUNDED' })),
    });
    await expect(renderer.render('ORDER_REFUNDED', 'o')).resolves.toEqual({
      kind: 'skipped-stale',
    });
  });

  it('the refunded amount is the REFUND entry (what reached the wallet)', async () => {
    const renderer = orderRenderer({
      order: () => Promise.resolve(orderRow({ status: 'REFUNDED' })),
      orderRefund: () => Promise.resolve({ amountTiyin: 5_000_000n }),
    });
    const { text } = message(await renderer.render('ORDER_REFUNDED', 'o'));
    expect(text.normalize('NFKC')).toContain('50 000 so‘m');
  });

  it('a DELIVERED order refunded later (admin refund) does not hear "it did not work out" (review M1)', async () => {
    const refundLookup = jest.fn(() => Promise.resolve(REFUND));
    const renderer = orderRenderer({
      order: () =>
        Promise.resolve(
          orderRow({ status: 'REFUNDED', deliveredAt: new Date('2030-01-01T09:00:00Z') }),
        ),
      orderRefund: refundLookup,
    });
    await expect(renderer.render('ORDER_REFUNDED', 'o')).resolves.toEqual({
      kind: 'skipped-stale',
    });
    expect(refundLookup).not.toHaveBeenCalled();
  });

  describe('the recipient name inside <code> (audit L-2, owner decision)', () => {
    const textFor = async (recipient: Record<string, string>, locale: 'uz' | 'ru' = 'uz') => {
      const row = orderRow({ recipient, user: { ...orderRow().user, locale } });
      const renderer = orderRenderer({ order: () => Promise.resolve(row) });
      return message(await renderer.render('ORDER_ACCEPTED', 'o')).text;
    };

    it.each(['uz', 'ru'] as const)(
      'a name with a link and a mention is code, the @username plain (%s)',
      async (locale) => {
        const text = await textFor(
          { username: 'ali_real', displayName: 'Ali t.me/evil_bot @evil_support' },
          locale,
        );
        expect(text.endsWith('→ <code>Ali t.me/evil_bot @evil_support</code> (@ali_real)')).toBe(
          true,
        );
      },
    );

    it('a name that tries to close the tag stays escaped inside it', async () => {
      const text = await textFor({
        username: 'ali_real',
        displayName: '</code><a href="https://evil.test">x</a>',
      });
      expect(text).toContain(
        '<code>&lt;/code&gt;&lt;a href="https://evil.test"&gt;x&lt;/a&gt;</code> (@ali_real)',
      );
      expect(text.split('<code>')).toHaveLength(2);
      expect(text.split('</code>')).toHaveLength(2);
      expect(text).not.toContain('<a ');
    });

    it('only a name: code; only a username: plain @username', async () => {
      expect(
        (await textFor({ displayName: 'Faqat Ism' })).endsWith('→ <code>Faqat Ism</code>'),
      ).toBe(true);
      expect(await textFor({ username: 'solo_user' })).toMatch(/→ @solo_user$/);
    });

    it.each(['uz', 'ru'] as const)(
      'a stored username that is not a Telegram username is code too (%s, re-review)',
      async (locale) => {
        const both = await textFor({ username: 't.me/x', displayName: 'Ali' }, locale);
        expect(both.endsWith('→ <code>Ali</code> (<code>@t.me/x</code>)')).toBe(true);
        expect(
          (await textFor({ username: 't.me/x' }, locale)).endsWith('→ <code>@t.me/x</code>'),
        ).toBe(true);
        // Too short for Telegram (5-32): not a mention either.
        expect((await textFor({ username: 'solo' }, locale)).endsWith('→ <code>@solo</code>')).toBe(
          true,
        );
      },
    );

    it('a product name that looks like the stand-in token is printed as it is', async () => {
      const row = orderRow({ product: { nameUz: 'r0123abc', nameRu: 'r0123abc' }, quantity: 1 });
      const renderer = orderRenderer({ order: () => Promise.resolve(row) });
      const { text } = message(await renderer.render('ORDER_ACCEPTED', 'o'));
      expect(text).toContain(': r0123abc → <code>Test User</code> (@test_user)');
    });
  });

  it('a missing order fails as source-missing', async () => {
    await expect(orderRenderer({}).render('ORDER_ACCEPTED', 'gone')).rejects.toBeInstanceOf(
      OrderSourceMissingError,
    );
  });

  it('no button without an https MINI_APP_URL', async () => {
    const renderer = orderRenderer({ order: () => Promise.resolve(orderRow()) }, null);
    expect(message(await renderer.render('ORDER_ACCEPTED', 'o')).replyMarkup).toBeUndefined();
  });
});
