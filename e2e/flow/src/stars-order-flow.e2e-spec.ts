import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUES, walletCacheKey } from '@repo/shared';
import { Queue } from 'bullmq';
import {
  queueJobIds,
  removeJobsAddedSince,
} from '../../../apps/api/src/infra/queue/__tests__/queue-jobs-cleanup';
import { FakeSender } from '../../../apps/api/src/modules/notifications/__tests__/tg-outbox.e2e-helpers';
import { TG_OUTBOX_SENDER } from '../../../apps/api/src/modules/notifications/tg-outbox.sender';
import { orderCreateLimitKey } from '../../../apps/api/src/modules/orders/orders.service';
import {
  newKey,
  usePaymentsE2e,
} from '../../../apps/api/src/modules/payments/__tests__/payments-e2e.helpers';
import { flowKit } from '../../../apps/api/src/modules/payments/__tests__/topup-flow.helpers';
import { topupRateKey } from '../../../apps/api/src/modules/payments/topup-limits';
import { quoteLimitKey } from '../../../apps/api/src/modules/quotes/quotes.service';
import { recipientCheckLimitKey } from '../../../apps/api/src/modules/recipients/recipients.service';
import {
  STARS_COST_NANO,
  STARS_PRICE,
  STARS_QTY,
  starsFlowCatalog,
  type StarsFlowCatalog,
} from './stars-flow.fixtures';
import { starsFlowKit } from './stars-flow.kit';
import { FlowWorkerSide } from './flow-worker-side';
import { endpointOf, installNetGuard } from './stars-net-guard';
import { WorkerSide } from './worker-side';

// Phase 5 S11 (plan §1 criterion 1: "Dry-run: a Stars order PAID -> DELIVERED, the bot message
// arrives"): a Telegram Stars order through the WHOLE system in one process on the real `_test`
// Postgres and Redis DB 15. Mini App login -> P2P top-up (the worker's bank-feed matcher writes the
// TOPUP) -> POST /recipients/validate (the REAL worker consumer answers from the dry-run Fragment
// simulator) -> POST /quotes (75 Stars) -> POST /orders (Idempotency-Key) -> the `fulfill-order`
// job -> the worker's real processor (simulator + FakeTonGateway, FULFILLMENT_DRY_RUN=true) ->
// DELIVERED -> notify job -> the API's notify consumer -> tg-outbox -> a FAKE Telegram sender.
// Nothing reaches Telegram, a bank, fragment.com or TON: fetch is a throwing spy and every socket
// connect except the test Postgres / Redis is refused and recorded (stars-net-guard.ts).
// Declared BEFORE usePaymentsE2e: its afterAll closes the app (and the API's queues) and runs
// first otherwise; this cleanup still needs them.
afterAll(async () => {
  try {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(guard.refused).toEqual([]);
    expect(guard.allowed()).toBeGreaterThan(0);
    fetchSpy?.mockRestore();
    await worker?.close(orderIds);
    await bankSide?.close();
    await removeJobsAddedSince(checkQueue(), checksBefore);
    const keys = userIds.flatMap((id) => [
      walletCacheKey(id),
      orderCreateLimitKey(id),
      quoteLimitKey(id),
      recipientCheckLimitKey(id),
      topupRateKey(id),
    ]);
    if (keys.length > 0) await e2e.redis().del(...keys);
    for (const id of outboxIds) await outbox?.remove(id).catch(() => 0);
    await outbox?.close();
  } finally {
    await catalog?.restore();
  }
});

const sender = new FakeSender();
const e2e = usePaymentsE2e({
  env: { MINI_APP_URL: 'https://app.ggpin.test/tg' },
  overrides: [{ provide: TG_OUTBOX_SENDER, useValue: sender }],
});
// Installed when the file loads, before any hook connects (the env is built synchronously above):
// only this env's own Postgres and Redis. Removed after the app has closed.
const guard = installNetGuard([endpointOf(e2e.env.DATABASE_URL), endpointOf(e2e.env.REDIS_URL)]);
afterAll(() => guard.restore());
const outboxIds = new Set<string>();
const { walletOf, ledgerSum, deliver } = flowKit(e2e, outboxIds);
const userIds: string[] = [];
const orderIds = new Set<string>();
let worker: FlowWorkerSide | undefined;
let bankSide: WorkerSide | undefined;
let catalog: StarsFlowCatalog | undefined;
let outbox: Queue | undefined;
let fetchSpy: jest.SpyInstance | undefined;
let checksBefore = new Set<string>();

const checkQueue = (): Queue => e2e.app().get<Queue>(getQueueToken(QUEUES.VALIDATE_RECIPIENT));

beforeAll(async () => {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in a dry-run test');
  });
  catalog = await starsFlowCatalog(e2e.env.DATABASE_URL);
  checksBefore = await queueJobIds(checkQueue());
  worker = await FlowWorkerSide.boot();
  bankSide = await WorkerSide.boot();
  outbox = new Queue(QUEUES.TG_OUTBOX, { connection: { url: e2e.env.REDIS_URL } });
});

/** Set in beforeAll; a test never runs without them. */
const w = (): FlowWorkerSide => {
  if (worker === undefined) throw new Error('the worker side is not booted');
  return worker;
};
const cat = (): StarsFlowCatalog => {
  if (catalog === undefined) throw new Error('the catalog is not ready');
  return catalog;
};
const bank = (): WorkerSide => {
  if (bankSide === undefined) throw new Error('the bank side is not booted');
  return bankSide;
};

const {
  buyer,
  username,
  order,
  quoteFor,
  placed,
  detail,
  ledgerOf,
  eventsOf,
  deliveredJobs,
  transfersOf,
  botText,
} = starsFlowKit({ e2e, sender, deliver, catalog: cat, bank, userIds, orderIds });

/** The exact bot texts of docs/07 (bot.order.accepted / delivered) for this order, per locale. */
const TEXTS = {
  uz: {
    accepted: (n: number, product: string, name: string) =>
      `🧾 #${String(n)} buyurtma qabul qilindi: ${product} → @${name}`,
    delivered: (n: number, product: string, name: string) =>
      `🎉 #${String(n)} yetkazildi! ${product} → @${name}`,
  },
  ru: {
    accepted: (n: number, product: string, name: string) =>
      `🧾 Заказ #${String(n)} принят: ${product} → @${name}`,
    delivered: (n: number, product: string, name: string) =>
      `🎉 Заказ #${String(n)} выполнен! ${product} → @${name}`,
  },
} as const;

describe('Telegram Stars, the whole order flow (P2P top-up, simulated Fragment, fake chain, fake Telegram)', () => {
  it.each(['uz', 'ru'] as const)(
    '%s: top-up -> validate -> quote -> order -> worker -> DELIVERED, timeline, ledger, bot texts',
    async (locale) => {
      const user = await buyer(locale);
      expect(user.funded).toBeGreaterThan(STARS_PRICE);
      expect(await walletOf(user)).toBe(user.funded.toString());

      const name = username();
      const { recipient, quote } = await quoteFor(user, name);
      expect(recipient).toMatchObject({ displayName: name, warnings: [] });
      expect(quote).toMatchObject({
        priceTiyin: STARS_PRICE.toString(),
        discountTiyin: '0',
        totalTiyin: STARS_PRICE.toString(),
        recipient: { username: name, displayName: name },
      });

      const key = newKey();
      const created = await placed(user, quote.quoteId, key);
      expect(created).toMatchObject({
        status: 'PAID',
        productId: cat().productId,
        skuId: null,
        quantity: STARS_QTY,
        totalTiyin: STARS_PRICE.toString(),
      });
      expect(await walletOf(user)).toBe((user.funded - STARS_PRICE).toString());
      expect(await w().hasFulfillJob(created.id)).toBe(true);

      const product = `${cat().productName[locale]} × ${String(STARS_QTY)}`;
      expect(await botText(user, 'accepted', created.id)).toBe(
        TEXTS[locale].accepted(created.number, product, name),
      );

      const chainBefore = w().executedOnChain();
      await expect(w().fulfil(created.id)).resolves.toBe('DONE');
      expect(w().executedOnChain() - chainBefore).toBe(1);
      expect(await transfersOf(created.id)).toEqual([STARS_COST_NANO]);

      // The OrderEvent rows themselves, then the API's timeline built from them.
      expect(await eventsOf(created.id)).toEqual([
        [null, 'PAID'],
        ['PAID', 'QUEUED'],
        ['QUEUED', 'PROCESSING'],
        ['PROCESSING', 'DELIVERED'],
      ]);
      const { raw, shown } = await detail(user, created.id, locale);
      expect(shown).toMatchObject({
        id: created.id,
        status: 'DELIVERED',
        quantity: STARS_QTY,
        productName: cat().productName[locale],
        voucher: null,
      });
      expect(shown.deliveredAt).not.toBeNull();
      expect(shown.timeline.map((s) => s.status)).toEqual([
        'PAID',
        'QUEUED',
        'PROCESSING',
        'DELIVERED',
      ]);
      // Money travels as strings in the JSON itself (CLAUDE.md invariant 1).
      expect(raw).toMatchObject({
        priceTiyin: STARS_PRICE.toString(),
        discountTiyin: '0',
        totalTiyin: STARS_PRICE.toString(),
      });

      const text = await botText(user, 'delivered', created.id);
      expect(text).toBe(TEXTS[locale].delivered(created.number, product, name));
      const other = locale === 'uz' ? 'ru' : 'uz';
      expect(text).not.toBe(TEXTS[other].delivered(created.number, product, name));

      // One PURCHASE under ORDER/<orderId>, no REFUND; balance == SUM(ledger).
      expect(await ledgerOf(user.id)).toEqual([
        ['TOPUP', user.funded, 'PAYMENT', user.paymentId],
        ['PURCHASE', -STARS_PRICE, 'ORDER', created.id],
      ]);
      expect(await walletOf(user)).toBe((user.funded - STARS_PRICE).toString());
      expect(await ledgerSum(user.id)).toBe(user.funded - STARS_PRICE);
    },
  );

  it('the same order request twice, again after delivery, and a worker re-run: one order, one PURCHASE, one payout, one "delivered"', async () => {
    const user = await buyer('uz');
    const { quote } = await quoteFor(user, username());
    const key = newKey();
    const first = await placed(user, quote.quoteId, key);
    expect((await placed(user, quote.quoteId, key)).id).toBe(first.id);

    const chainBefore = w().executedOnChain();
    await expect(w().fulfil(first.id)).resolves.toBe('DONE');
    expect(await botText(user, 'delivered', first.id)).toContain(`#${String(first.number)}`);
    expect(await deliveredJobs(first.id)).toEqual({ notify: 1, outbox: 1 });
    // The re-run's money effects first (no second payout), then how it ended.
    const rerun = await w().fulfil(first.id);
    expect(w().executedOnChain() - chainBefore).toBe(1);
    expect(await transfersOf(first.id)).toEqual([STARS_COST_NANO]);
    expect(rerun).toBe('REPLAYED');
    expect(await deliveredJobs(first.id)).toEqual({ notify: 1, outbox: 1 });

    const late = await placed(user, quote.quoteId, key);
    expect(late.id).toBe(first.id);
    expect(await e2e.db().order.count({ where: { userId: user.id } })).toBe(1);
    expect(await ledgerOf(user.id)).toEqual([
      ['TOPUP', user.funded, 'PAYMENT', user.paymentId],
      ['PURCHASE', -STARS_PRICE, 'ORDER', first.id],
    ]);
    expect(await ledgerSum(user.id)).toBe(user.funded - STARS_PRICE);

    expect(sender.deliveriesTo(user.chatId)).toHaveLength(1);
    expect((await detail(user, first.id)).shown.status).toBe('DELIVERED');
  });

  it('another user gets 404 on the order and on ordering with its quote; the owner still sees it', async () => {
    const a = await buyer('uz');
    const b = await buyer('ru', false);
    const { quote } = await quoteFor(a, username());
    const created = await placed(a, quote.quoteId);

    const res = await e2e.get(`/orders/${created.id}?locale=uz`, b);
    expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    // Exactly the answer for an order that does not exist at all: nothing tells them apart.
    const missing = await e2e.get(`/orders/c${randomBytes(12).toString('hex')}?locale=uz`, b);
    expect([missing.status, res.body]).toEqual([404, missing.body]);
    expect(JSON.stringify(res.body)).not.toContain(created.id);
    const list = await e2e.get('/orders', b);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    const stolen = await order(b, quote.quoteId);
    expect([stolen.status, stolen.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    expect(await e2e.db().order.count({ where: { userId: b.id } })).toBe(0);
    expect(await ledgerOf(b.id)).toEqual([]);

    expect((await detail(a, created.id)).shown.id).toBe(created.id);
    expect(await walletOf(b)).toBe('0');
    // A's order is not left PAID in the shared database: it is delivered like any other.
    await expect(w().fulfil(created.id)).resolves.toBe('DONE');
    expect((await detail(a, created.id)).shown.status).toBe('DELIVERED');
  });
});
