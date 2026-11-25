import { getQueueToken } from '@nestjs/bullmq';
import {
  InsufficientBalanceDetailsSchema,
  QUEUES,
  formatMoney,
  notifyJobId,
  walletCacheKey,
} from '@repo/shared';
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
import { flat, flowKit } from '../../../apps/api/src/modules/payments/__tests__/topup-flow.helpers';
import { quoteLimitKey } from '../../../apps/api/src/modules/quotes/quotes.service';
import { recipientCheckLimitKey } from '../../../apps/api/src/modules/recipients/recipients.service';
import { premiumFlowCatalog, type PremiumFlowCatalog } from './premium-flow.fixtures';
import { premiumFlowKit } from './premium-flow.kit';
import { FlowWorkerSide } from './flow-worker-side';

// Phase 6 S6 (plan §1 criterion 1 and 2 (a)): a Telegram Premium order through the WHOLE system
// in one process on the real `_test` Postgres and Redis DB 15. API: POST /recipients/validate ->
// the REAL worker consumer answers from the dry-run Fragment simulator -> POST /quotes (3-month
// SKU) -> POST /orders -> the `fulfill-order` job -> the worker's real processor (simulator +
// FakeTonGateway) -> DELIVERED -> notify job -> the API's notify consumer -> tg-outbox -> a FAKE
// Telegram sender. Nothing reaches Telegram, fragment.com or TON. The wallet is funded by a TOPUP
// entry (the top-up flow is topup-flow.e2e-spec.ts).
// Declared BEFORE usePaymentsE2e: its afterAll closes the app (and the API's queues) and
// runs first otherwise; this cleanup still needs them.
afterAll(async () => {
  try {
    // SA-F2: no outside call happened (the flows run on simulators and the in-memory chain).
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy?.mockRestore();
    await worker?.close(orderIds);
    await removeJobsAddedSince(checkQueue(), checksBefore);
    const keys = userIds.flatMap((id) => [
      walletCacheKey(id),
      orderCreateLimitKey(id),
      quoteLimitKey(id),
      recipientCheckLimitKey(id),
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
const outboxIds = new Set<string>();
const { walletOf, ledgerSum, deliver } = flowKit(e2e, outboxIds);
const userIds: string[] = [];
const orderIds = new Set<string>();
/** 3.75 TON x 40 000 so'm x 1.10 markup = 165 000 so'm. */
const PRICE = 16_500_000n;
let worker: FlowWorkerSide | undefined;
let catalog: PremiumFlowCatalog | undefined;
let outbox: Queue | undefined;
let fetchSpy: jest.SpyInstance | undefined;
let checksBefore = new Set<string>();

const checkQueue = (): Queue => e2e.app().get<Queue>(getQueueToken(QUEUES.VALIDATE_RECIPIENT));

beforeAll(async () => {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in a dry-run test');
  });
  catalog = await premiumFlowCatalog(e2e.env.DATABASE_URL);
  checksBefore = await queueJobIds(checkQueue());
  worker = await FlowWorkerSide.boot();
  outbox = new Queue(QUEUES.TG_OUTBOX, { connection: { url: e2e.env.REDIS_URL } });
});

/** Set in beforeAll; a test never runs without them. */
const w = (): FlowWorkerSide => {
  if (worker === undefined) throw new Error('the worker side is not booted');
  return worker;
};
const cat = (): PremiumFlowCatalog => {
  if (catalog === undefined) throw new Error('the catalog is not ready');
  return catalog;
};

const {
  buyer,
  username,
  validate,
  order,
  quoteFor,
  placed,
  detail,
  ledgerOf,
  transfersOf,
  botText,
} = premiumFlowKit({ e2e, sender, deliver, catalog: cat, userIds, orderIds });

describe('Telegram Premium, the whole order flow (simulated Fragment, fake chain, fake Telegram)', () => {
  it.each([
    ['uz', 'Telegram Premium (3 oylik)'],
    ['ru', 'Telegram Premium (3 месяца)'],
  ] as const)(
    '%s: validate -> quote (3 months) -> order -> worker -> DELIVERED, timeline, bot "%s"',
    async (locale, product) => {
      const user = await buyer(locale, PRICE);
      const name = username('prem_');
      const { recipient, quote } = await quoteFor(user, name);
      expect(recipient).toMatchObject({ displayName: name, warnings: [] });
      const q = await quote();
      expect(q).toMatchObject({ priceTiyin: PRICE.toString(), totalTiyin: PRICE.toString() });
      expect(q.recipient).toEqual({ username: name, displayName: name });

      const created = await placed(user, q.quoteId);
      expect(created).toMatchObject({
        status: 'PAID',
        productSlug: 'telegram-premium',
        skuId: cat().sku3,
        quantity: 3,
        totalTiyin: PRICE.toString(),
      });
      expect(await walletOf(user)).toBe('0');
      expect(await w().hasFulfillJob(created.id)).toBe(true);
      expect(await botText(user, 'accepted', created.id)).toContain(product);

      const chainBefore = w().executedOnChain();
      await expect(w().fulfil(created.id)).resolves.toBe('DONE');
      expect(w().executedOnChain() - chainBefore).toBe(1);

      const shown = await detail(user, created.id, locale);
      expect(shown).toMatchObject({ status: 'DELIVERED', quantity: 3, skuId: cat().sku3 });
      expect(shown.deliveredAt).not.toBeNull();
      expect(shown.timeline.map((s) => s.status)).toEqual([
        'PAID',
        'QUEUED',
        'PROCESSING',
        'DELIVERED',
      ]);
      expect(await transfersOf(created.id)).toEqual([3_750_000_000n]);
      const text = await botText(user, 'delivered', created.id);
      expect(text).toContain(product);
      expect(text).toContain(`#${String(created.number)}`);
      expect(await ledgerOf(user.id)).toEqual([
        ['TOPUP', PRICE, 'PAYMENT'],
        ['PURCHASE', -PRICE, 'ORDER'],
      ]);
      expect(await ledgerSum(user.id)).toBe(0n);
    },
  );

  it('haspremium_: 422 RECIPIENT_HAS_PREMIUM, no token, no quote, no order, balance unchanged', async () => {
    const user = await buyer('uz', PRICE);
    const res = await validate(user, username('haspremium_'));
    expect([res.status, res.body.error?.code]).toEqual([422, 'RECIPIENT_HAS_PREMIUM']);
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/recipientToken/);
    expect(await e2e.db().quote.count({ where: { userId: user.id } })).toBe(0);
    expect(await e2e.db().order.count({ where: { userId: user.id } })).toBe(0);
    expect(await walletOf(user)).toBe(PRICE.toString());
    expect(await ledgerSum(user.id)).toBe(PRICE);
  });

  it('premiumext_: 200 with the PREMIUM_EXTENDS warning, and the order is DELIVERED', async () => {
    const user = await buyer('uz', PRICE);
    const { recipient, quote } = await quoteFor(user, username('premiumext_'));
    expect(recipient.warnings).toEqual([
      { code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' },
    ]);
    const created = await placed(user, (await quote()).quoteId);
    await expect(w().fulfil(created.id)).resolves.toBe('DONE');
    expect((await detail(user, created.id)).status).toBe('DELIVERED');
    expect(await ledgerSum(user.id)).toBe(0n);
  });

  it('GOT_PREMIUM at prepare: FAILED -> REFUNDED (RECIPIENT_GONE), one REFUND, nothing paid, bot told', async () => {
    const user = await buyer('uz', PRICE);
    const { quote } = await quoteFor(user, username('prem_'));
    const created = await placed(user, (await quote()).quoteId);
    w().script.set(created.id, 'GOT_PREMIUM');
    // CR F1: the spent balance is read and CACHED before the worker runs, so the refund must drop
    // that cache entry (after its commit) for the customer to see the money back.
    expect(await walletOf(user)).toBe('0');
    expect(await e2e.redis().exists(walletCacheKey(user.id))).toBe(1);
    const chainBefore = w().executedOnChain();
    await expect(w().fulfil(created.id)).resolves.toBe('DONE');

    expect(w().executedOnChain()).toBe(chainBefore);
    const row = await e2e.db().order.findUniqueOrThrow({ where: { id: created.id } });
    expect([row.status, row.statusReason]).toEqual(['REFUNDED', 'RECIPIENT_GONE']);
    const shown = await detail(user, created.id);
    expect(shown.timeline.map((s) => s.status)).toEqual([
      'PAID',
      'QUEUED',
      'PROCESSING',
      'FAILED',
      'REFUNDED',
    ]);
    expect(await e2e.db().fulfillmentAttempt.count({ where: { orderId: created.id } })).toBe(0);
    expect(await ledgerOf(user.id)).toEqual([
      ['TOPUP', PRICE, 'PAYMENT'],
      ['PURCHASE', -PRICE, 'ORDER'],
      ['REFUND', PRICE, 'ORDER'],
    ]);
    expect(await walletOf(user)).toBe(PRICE.toString());
    expect(await ledgerSum(user.id)).toBe(PRICE);
    expect(await botText(user, 'refunded', created.id)).toContain(flat(formatMoney(PRICE, 'uz')));
  });

  it('two purchases at once with money for one: [201, 422], one PURCHASE, one job', async () => {
    const user = await buyer('uz', PRICE + PRICE / 2n);
    const { quote } = await quoteFor(user, username('prem_'));
    const [q1, q2] = [await quote(), await quote()];
    const results = await Promise.all([order(user, q1.quoteId), order(user, q2.quoteId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const lost = results.find((r) => r.status === 422);
    expect(lost?.body.error?.code).toBe('INSUFFICIENT_BALANCE');
    expect(InsufficientBalanceDetailsSchema.parse(lost?.body.error?.details)).toEqual({
      balance: (PRICE / 2n).toString(),
      required: PRICE.toString(),
      shortfall: (PRICE / 2n).toString(),
    });
    const orders = await e2e.db().order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    for (const o of orders) orderIds.add(o.id);
    const won = orders[0]?.id ?? '';
    expect(await w().hasFulfillJob(won)).toBe(true);
    const purchases = await e2e.db().ledgerEntry.count({
      where: { userId: user.id, kind: 'PURCHASE' },
    });
    expect(purchases).toBe(1);
    expect(await walletOf(user)).toBe((PRICE / 2n).toString());
    expect(await ledgerSum(user.id)).toBe(PRICE / 2n);
  });

  it('the same order request twice and a worker retry after delivery: one order, one PURCHASE, one payout', async () => {
    const user = await buyer('uz', PRICE * 2n);
    const { quote } = await quoteFor(user, username('prem_'));
    const q = await quote();
    const key = newKey();
    const first = await placed(user, q.quoteId, key);
    const again = await placed(user, q.quoteId, key);
    expect(again.id).toBe(first.id);
    const chainBefore = w().executedOnChain();
    await expect(w().fulfil(first.id)).resolves.toBe('DONE');
    await expect(w().fulfil(first.id)).resolves.toBe('REPLAYED');
    expect(w().executedOnChain() - chainBefore).toBe(1);
    expect((await placed(user, q.quoteId, key)).id).toBe(first.id);
    expect(await e2e.db().order.count({ where: { userId: user.id } })).toBe(1);
    expect(await ledgerOf(user.id)).toEqual([
      ['TOPUP', PRICE * 2n, 'PAYMENT'],
      ['PURCHASE', -PRICE, 'ORDER'],
    ]);
    expect(await transfersOf(first.id)).toEqual([3_750_000_000n]);
    const jobs = await e2e.notifyQueue().getJobs(['waiting', 'delayed', 'completed', 'failed']);
    const delivered = notifyJobId({ kind: 'ORDER_DELIVERED', refId: first.id });
    expect(jobs.filter((j) => j.id === delivered)).toHaveLength(1);
  });

  it("another user's order is 404 (detail and list); the owner still sees it", async () => {
    const a = await buyer('uz', PRICE);
    const b = await buyer('uz', 0n);
    const { quote } = await quoteFor(a, username('prem_'));
    const created = await placed(a, (await quote()).quoteId);
    const res = await e2e.get(`/orders/${created.id}?locale=uz`, b);
    expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify(res.body)).not.toContain(created.id);
    const list = await e2e.get('/orders', b);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect((await detail(a, created.id)).id).toBe(created.id);
    expect(await walletOf(b)).toBe('0');
  });
});
