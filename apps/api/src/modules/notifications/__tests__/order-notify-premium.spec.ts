import { ORDER_NOTIFY_KINDS, tgOutboxJobSchema, type OrderNotifyKind } from '@repo/shared';
import type { OrderNotifyResult } from '../order-notify.renderer';
import { norm, orderRenderer, orderRow } from './order-notify.test-fixtures';

// Telegram Premium packs as the catalog seed labels them (packages/db/prisma/seed/catalog-data.ts).
const PACKS = [
  { months: 3, labelUz: '3 oylik', labelRu: '3 месяца' },
  { months: 6, labelUz: '6 oylik', labelRu: '6 месяцев' },
  { months: 12, labelUz: '12 oylik', labelRu: '12 месяцев' },
] as const;
const NAME = 'Telegram Premium';
const REFUND = { amountTiyin: 12_345_600n };

const ROW_FOR: Readonly<Record<OrderNotifyKind, Parameters<typeof orderRow>[0]>> = {
  ORDER_ACCEPTED: { status: 'PAID' },
  ORDER_DELIVERED: { status: 'DELIVERED', deliveredAt: new Date('2030-01-01T09:00:00Z') },
  ORDER_REVIEW: { status: 'HELD', statusReason: 'LOW_BALANCE' },
  ORDER_REFUNDED: { status: 'REFUNDED', statusReason: 'HELD_EXPIRED' },
};

function message(result: OrderNotifyResult) {
  if (result.kind !== 'message') throw new Error(`expected a message, got ${result.kind}`);
  return tgOutboxJobSchema.parse(result.job);
}

function premiumRow(
  pack: (typeof PACKS)[number],
  locale: 'uz' | 'ru',
  over: Parameters<typeof orderRow>[0] = {},
) {
  return orderRow({
    quantity: 1,
    product: { nameUz: NAME, nameRu: NAME },
    sku: { labelUz: pack.labelUz, labelRu: pack.labelRu },
    user: { ...orderRow().user, locale },
    ...over,
  });
}

async function render(kind: OrderNotifyKind, row: ReturnType<typeof orderRow>) {
  const renderer = orderRenderer({
    order: () => Promise.resolve(row),
    orderRefund: () => Promise.resolve(REFUND),
  });
  return message(await renderer.render(kind, 'cmorder1'));
}

describe('Premium order messages (bot.order.*)', () => {
  const cases = ORDER_NOTIFY_KINDS.flatMap((kind) =>
    PACKS.flatMap((pack) => (['uz', 'ru'] as const).map((l) => [kind, pack.months, l] as const)),
  );

  it.each(cases)('%s, %i months, %s: snapshot', async (kind, months, locale) => {
    const pack = PACKS.find((p) => p.months === months);
    if (pack === undefined) throw new Error('unknown pack');
    const job = await render(kind, premiumRow(pack, locale, ROW_FOR[kind]));
    expect(norm(job)).toMatchSnapshot();
  });

  // Accepted and delivered name the product; reviewing and refunded carry only the number
  // (and the amount), so the pack label belongs to the first two kinds.
  it.each(PACKS.flatMap((p) => (['uz', 'ru'] as const).map((l) => [p, l] as const)))(
    'accepted and delivered print "%j" label in the product text (%s)',
    async (pack, locale) => {
      const label = locale === 'ru' ? pack.labelRu : pack.labelUz;
      for (const kind of ['ORDER_ACCEPTED', 'ORDER_DELIVERED'] as const) {
        const { text } = await render(kind, premiumRow(pack, locale, ROW_FOR[kind]));
        expect(text).toContain(`${NAME} (${label}) → `);
      }
    },
  );

  it('the ru plural of the pack is right: 3 месяца, 6 месяцев, 12 месяцев', async () => {
    const texts: string[] = [];
    for (const pack of PACKS) {
      texts.push(
        (await render('ORDER_ACCEPTED', premiumRow(pack, 'ru', ROW_FOR.ORDER_ACCEPTED))).text,
      );
    }
    expect(texts[0]).toContain('(3 месяца)');
    expect(texts[1]).toContain('(6 месяцев)');
    expect(texts[2]).toContain('(12 месяцев)');
  });

  it('the uz pack is "(3 oylik)" and the name stays inside <code>', async () => {
    const { text } = await render(
      'ORDER_ACCEPTED',
      premiumRow(PACKS[0], 'uz', ROW_FOR.ORDER_ACCEPTED),
    );
    expect(text).toContain('(3 oylik)');
    expect(text.endsWith('→ <code>Test User</code> (@test_user)')).toBe(true);
  });

  it.each(['uz', 'ru'] as const)(
    'delivered: the recipient name is code, the plain @username follows (%s)',
    async (locale) => {
      const { text } = await render(
        'ORDER_DELIVERED',
        premiumRow(PACKS[2], locale, {
          ...ROW_FOR.ORDER_DELIVERED,
          recipient: { username: 'ali_real', displayName: 'Ali t.me/evil_bot' },
        }),
      );
      expect(text.endsWith('<code>Ali t.me/evil_bot</code> (@ali_real)')).toBe(true);
    },
  );

  it.each(['uz', 'ru'] as const)(
    'escapes <, > and & in the name, username and pack label (%s)',
    async (locale) => {
      const row = premiumRow(PACKS[0], locale, {
        recipient: { username: 'a<b>&c', displayName: '<b>Boss</b> & co' },
        sku: { labelUz: '3 <oylik> & x', labelRu: '3 <месяца> & x' },
      });
      const { text } = await render('ORDER_ACCEPTED', row);
      expect(text).toContain('<code>&lt;b&gt;Boss&lt;/b&gt; &amp; co</code>');
      expect(text).toContain('<code>@a&lt;b&gt;&amp;c</code>');
      expect(text).toMatch(/\(3 &lt;(oylik|месяца)&gt; &amp; x\)/);
      expect(text).not.toMatch(/<b>|<oylik>|<месяца>/);
      expect(text.split('<code>')).toHaveLength(3);
    },
  );

  it.each(['uz', 'ru'] as const)(
    'reviewing and refunded carry the number, not the pack (%s)',
    async (locale) => {
      const review = await render(
        'ORDER_REVIEW',
        premiumRow(PACKS[1], locale, ROW_FOR.ORDER_REVIEW),
      );
      const refunded = await render(
        'ORDER_REFUNDED',
        premiumRow(PACKS[1], locale, ROW_FOR.ORDER_REFUNDED),
      );
      expect(review.text).toContain('#1042');
      expect(refunded.text).toContain('#1042');
      expect(refunded.text.normalize('NFKC')).toContain('123 456');
      expect(review.text).not.toContain(NAME);
    },
  );
});
