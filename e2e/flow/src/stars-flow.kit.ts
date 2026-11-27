import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import {
  CreateOrderResponseSchema,
  OrderDetailSchema,
  QUEUES,
  QuoteResponseSchema,
  TopupIntentCreatedSchema,
  ValidateRecipientResponseSchema,
  webAppLoginResponseSchema,
  notifyJobSchema,
  type Locale,
  type OrderStatus,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { nextTestTelegramId } from '../../../apps/api/src/config/__tests__/test-telegram-id';
import { buildInitData } from '../../../apps/api/src/modules/auth/__tests__/init-data.fixtures';
import type { FakeSender } from '../../../apps/api/src/modules/notifications/__tests__/tg-outbox.e2e-helpers';
import { chatGateKey } from '../../../apps/api/src/modules/notifications/tg-outbox.consumer';
import {
  newKey,
  type PaymentsE2e,
} from '../../../apps/api/src/modules/payments/__tests__/payments-e2e.helpers';
import { flat } from '../../../apps/api/src/modules/payments/__tests__/topup-flow.helpers';
import { STARS_QTY, type StarsFlowCatalog } from './stars-flow.fixtures';
import type { WorkerSide } from './worker-side';

// The steps of the Stars order flow spec (phase 5 S11), each through the real HTTP routes with
// the buyer's Mini App bearer token, plus the reads the spec asserts on. The buyer logs in with
// signed initData (its Telegram language decides the account's locale) and funds the wallet by
// the REAL P2P top-up: a request on a fresh UZCARD card, a synthetic bank message through the
// worker's ingest and matcher, which writes the TOPUP entry. No ledger row is written by hand.

export interface Buyer {
  readonly id: string;
  readonly bearer: Record<string, string>;
  readonly chatId: string;
  /** What the top-up credited (tiyin); 0 for a buyer who did not top up. */
  readonly funded: bigint;
  /** The TOPUP's payment id; null without a top-up. */
  readonly paymentId: string | null;
}

export interface KitDeps {
  readonly e2e: PaymentsE2e;
  readonly sender: FakeSender;
  /** flowKit's deliver: the notify job through the API's notify and tg-outbox consumers. */
  readonly deliver: (jobId: string) => Promise<unknown>;
  readonly catalog: () => StarsFlowCatalog;
  readonly bank: () => WorkerSide;
  /** Filled for the spec's cleanup. */
  readonly userIds: string[];
  readonly orderIds: Set<string>;
}

export function starsFlowKit(deps: KitDeps) {
  const { e2e, sender, deliver, catalog, bank, userIds, orderIds } = deps;
  const sfx = randomBytes(4).toString('hex');
  let seq = 0;

  /** A real Mini App login whose Telegram language is `locale`. */
  async function login(locale: Locale) {
    const telegramId = nextTestTelegramId();
    const initData = buildInitData({
      botToken: e2e.env.TELEGRAM_BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000) - 5,
      user: {
        id: telegramId,
        first_name: 'Buyer',
        username: `stars_${String(telegramId)}`,
        language_code: locale,
      },
    });
    const res = await e2e.send(
      'POST',
      '/auth/telegram/webapp',
      { 'x-csrf-token': 'e2e', origin: e2e.env.WEB_URL },
      { initData },
    );
    expect(res.status).toBe(200);
    const parsed = webAppLoginResponseSchema.parse(res.body.data);
    userIds.push(parsed.user.id);
    return {
      id: parsed.user.id,
      bearer: { authorization: `Bearer ${parsed.token}` },
      chatId: String(telegramId),
    };
  }

  /** The P2P top-up: request -> synthetic bank CREDIT -> worker matcher -> TOPUP entry. */
  async function topup(user: { id: string; bearer: Record<string, string> }) {
    await e2e.card({ bank: 'UZCARD' }); // a live card in the pool; the allocator picks the card
    const res = await e2e.create(user);
    expect(res.status).toBe(201);
    const intent = TopupIntentCreatedSchema.parse(res.body.data);
    const amount = BigInt(intent.payAmountTiyin);
    // The money goes to the card THIS request shows (another live card may have been picked).
    const last4 = intent.card.number.slice(-4);
    const received = await bank().receive({ last4, amountTiyin: amount });
    if (!received.stored) throw new Error(`bank message not stored: ${received.reason}`);
    await expect(bank().runJob(received.bankMessageId)).resolves.toBe('PROCESSED');
    const entry = await e2e.db().ledgerEntry.findFirstOrThrow({
      where: { userId: user.id, kind: 'TOPUP' },
    });
    expect([entry.amountTiyin, entry.refType]).toEqual([amount, 'PAYMENT']);
    const payment = await e2e.db().payment.findUniqueOrThrow({ where: { id: entry.refId } });
    expect(payment).toMatchObject({
      userId: user.id,
      intentId: intent.intentId,
      status: 'CONFIRMED',
      amountTiyin: amount,
    });
    return { amount, paymentId: entry.refId };
  }

  async function buyer(locale: Locale, fund = true): Promise<Buyer> {
    const user = await login(locale);
    const row = await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.locale).toBe(locale);
    if (!fund) return { ...user, funded: 0n, paymentId: null };
    const { amount, paymentId } = await topup(user);
    return { ...user, funded: amount, paymentId };
  }

  /** A username unique to this run that the simulator answers FOUND for. */
  const username = (): string => `stars${sfx}_${String(++seq)}`;

  const validate = (user: Buyer, name: string) =>
    e2e.send('POST', '/recipients/validate', user.bearer, {
      productId: catalog().productId,
      input: { username: name },
    });

  const order = (user: Buyer, quoteId: string, key: string = newKey()) =>
    e2e.send('POST', '/orders', { ...user.bearer, 'idempotency-key': key }, { quoteId });

  /** validate (200), then a quote of STARS_QTY Stars with that token (201). */
  async function quoteFor(user: Buyer, name: string) {
    const checked = await validate(user, name);
    expect(checked.status).toBe(200);
    const recipient = ValidateRecipientResponseSchema.parse(checked.body.data);
    const res = await e2e.send('POST', '/quotes', user.bearer, {
      productId: catalog().productId,
      quantity: STARS_QTY,
      recipientToken: recipient.recipientToken,
    });
    expect(res.status).toBe(201);
    const quote = QuoteResponseSchema.parse(res.body.data);
    // Priced with this suite's own TON_UZS rate, not one another suite left in the shared DB.
    const row = await e2e.db().quote.findUniqueOrThrow({ where: { id: quote.quoteId } });
    expect(row.fxRateId).toBe(catalog().fxRateId);
    return { recipient, quote };
  }

  async function placed(user: Buyer, quoteId: string, key?: string) {
    const res = await order(user, quoteId, key);
    expect(res.status).toBe(201);
    const created = CreateOrderResponseSchema.parse(res.body.data).order;
    orderIds.add(created.id);
    return created;
  }

  /** GET /orders/:id: the raw `data` (to see the JSON types) and the parsed detail. */
  async function detail(user: Buyer, orderId: string, locale: Locale = 'uz') {
    const res = await e2e.get(`/orders/${orderId}?locale=${locale}`, user);
    expect(res.status).toBe(200);
    return { raw: res.body.data, shown: OrderDetailSchema.parse(res.body.data) };
  }

  /** The user's ledger, oldest first: [kind, amount, refType, refId]. */
  async function ledgerOf(userId: string) {
    const rows = await e2e.db().ledgerEntry.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((e) => [e.kind, e.amountTiyin, e.refType, e.refId] as const);
  }

  /** The order's OrderEvent rows as the status chain they form, from creation on (see below). */
  async function eventsOf(orderId: string) {
    const rows = await e2e.db().orderEvent.findMany({
      where: { orderId },
      select: { from: true, to: true },
    });
    // Walked as a chain (from null, then the event that leaves the status the last one entered),
    // never by time or id: two events can share a millisecond and cuid2 ids are not ordered. Each
    // step must be the ONLY event leaving that status, and every row must be on the chain.
    const chain: (readonly [OrderStatus | null, OrderStatus])[] = [];
    let current: OrderStatus | null = null;
    for (;;) {
      const leaving = rows.filter((e) => e.from === current);
      if (leaving.length === 0) break;
      expect(leaving).toHaveLength(1);
      const [step] = leaving;
      if (step === undefined) break;
      chain.push([step.from, step.to]);
      current = step.to;
      if (chain.length > rows.length) throw new Error('the OrderEvent rows loop');
    }
    expect(chain).toHaveLength(rows.length);
    return chain;
  }

  /** Every queued `ORDER_DELIVERED` of this order: notify jobs (by data) and tg-outbox jobs. */
  async function deliveredJobs(orderId: string) {
    // tg-outbox jobs carry a BullMQ priority, so a queued one sits in 'prioritized'.
    const states = ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'] as const;
    const notify = (await e2e.notifyQueue().getJobs([...states])).filter((j) => {
      const data = notifyJobSchema.safeParse(j.data);
      return data.success && data.data.kind === 'ORDER_DELIVERED' && data.data.refId === orderId;
    });
    const outbox = e2e.app().get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));
    const sent = (await outbox.getJobs([...states])).filter(
      (j) => (j.id ?? '').includes(orderId) && (j.id ?? '').includes('delivered'),
    );
    return { notify: notify.length, outbox: sent.length };
  }

  /** The amounts (nanotons) of the TON transfers made for an order's attempts. */
  async function transfersOf(orderId: string): Promise<bigint[]> {
    const rows = await e2e.db().tonTransfer.findMany({
      where: { attempt: { orderId } },
      select: { amountNanoTon: true },
    });
    return rows.map((r) => r.amountNanoTon);
  }

  /** The notify job through the API's consumers; the text the fake Telegram got for it. */
  async function botText(user: Buyer, kind: 'accepted' | 'delivered', orderId: string) {
    // One message per chat per second (the consumer's chat gap): wait the gate's own TTL in
    // Redis (PTTL), not the host clock, as the BullMQ worker's delayed retry would.
    for (let round = 0; ; round += 1) {
      const ttlMs = await e2e.redis().pttl(chatGateKey(user.chatId));
      if (ttlMs === -2) break;
      if (ttlMs === -1 || round >= 15) throw new Error('the chat gap did not pass');
      await new Promise((resolve) => setTimeout(resolve, Math.min(ttlMs, 1_000) + 20));
    }
    const before = sender.deliveriesTo(user.chatId).length;
    await deliver(`order-${orderId}-${kind}`);
    const sent = sender.deliveriesTo(user.chatId);
    expect(sent).toHaveLength(before + 1);
    return flat(sent.at(-1)?.job.text ?? '');
  }

  return {
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
  };
}
