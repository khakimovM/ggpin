import {
  PayViewSchema,
  QUEUES,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  formatMoney,
  walletCacheKey,
} from '@repo/shared';
import { Queue } from 'bullmq';
import { FakeSender } from '../../notifications/__tests__/tg-outbox.e2e-helpers';
import { TG_OUTBOX_SENDER } from '../../notifications/tg-outbox.sender';
import { HOUR, MINUTE, tokenOf, usePaymentsE2e } from './payments-e2e.helpers';
import { flat, flowKit } from './topup-flow.helpers';
import { settleIntent } from './topup-flow.settle';

// The API half of the P2P top-up on the real ggpin_test Postgres and Redis DB 15: real Mini App
// login -> intent -> pay page -> [the worker credits: see topup-flow.settle.ts] -> the `notify`
// job -> the API's notify consumer -> `tg-outbox` job -> the tg-outbox consumer with a FAKE
// Telegram sender -> /me/wallet. The worker half (fake bank feed -> ingest -> processor ->
// TOPUP) is apps/worker .../topup-flow.e2e-spec.ts: the API cannot import worker code. No BullMQ
// Worker runs, nothing reaches Telegram or a bank; every bank value is SYNTHETIC.
const sender = new FakeSender();
const e2e = usePaymentsE2e({
  env: { OWNER_ALERT_CHAT_ID: '7000000002', MINI_APP_URL: 'https://app.ggpin.test/tg' },
  overrides: [{ provide: TG_OUTBOX_SENDER, useValue: sender }],
});
const outboxIds = new Set<string>();
const { login, walletOf, requestTopup, ledgerSum, deliver } = flowKit(e2e, outboxIds);
let outbox: Queue;

beforeAll(() => {
  outbox = new Queue(QUEUES.TG_OUTBOX, { connection: { url: e2e.env.REDIS_URL } });
});

afterAll(async () => {
  for (const id of outboxIds) await outbox.remove(id).catch(() => 0);
  await outbox.close();
});

describe('P2P top-up, the API half of the flow (fake Telegram)', () => {
  it('login -> intent -> pay page -> credit -> notify -> outbox -> /me/wallet', async () => {
    const { card, user, intent, amount } = await requestTopup();
    const token = tokenOf(intent.redirectUrl);
    expect(await walletOf(user)).toBe('0');
    expect(await e2e.redis().exists(walletCacheKey(user.id))).toBe(1); // the empty balance is cached

    const view = await e2e.pay(intent.intentId, token);
    expect(view.status).toBe(200);
    expect(PayViewSchema.parse(view.body.data)).toMatchObject({
      status: 'PENDING',
      payAmountTiyin: amount.toString(),
      card: { number: card.pan },
    });

    const paymentId = await settleIntent(e2e, {
      intentId: intent.intentId,
      userId: user.id,
      cardId: card.id,
      last4: card.last4,
      amountTiyin: amount,
      late: false,
    });
    expect(await e2e.redis().exists(walletCacheKey(user.id))).toBe(0);
    expect(await walletOf(user)).toBe(amount.toString());
    expect(await ledgerSum(user.id)).toBe(amount); // balance == SUM(ledger)

    const paid = TopupIntentSchema.parse(
      (await e2e.get(`/payments/intents/${intent.intentId}`, user)).body.data,
    );
    expect(paid).toMatchObject({ status: 'PAID', card: null, creditedTiyin: amount.toString() });
    const items = (await e2e.get('/me/ledger', user)).body.data as {
      kind: string;
      paymentId: string;
    }[];
    expect(items.map((i) => [i.kind, i.paymentId])).toEqual([['TOPUP', paymentId]]);
    expect(PayViewSchema.parse((await e2e.pay(intent.intentId, token)).body.data)).toMatchObject({
      status: 'PAID',
      card: null,
    });

    expect(await deliver(`topup-${paymentId}`)).toEqual({
      kind: 'TOPUP_CREDITED',
      refId: paymentId,
    });
    const sent = sender.deliveriesTo(user.telegramId.toString());
    expect(sent).toHaveLength(1);
    expect(flat(sent[0]?.job.text ?? '')).toContain(flat(formatMoney(amount, 'uz')));
  });

  it('another user gets 404 on the intent, its cancel, its pay-link and its pay page; nothing leaks into their wallet', async () => {
    const a = await requestTopup();
    const b = await login();
    const bRes = await e2e.create(b);
    expect(bRes.status).toBe(201);
    const bIntent = TopupIntentCreatedSchema.parse(bRes.body.data);

    for (const res of [
      await e2e.get(`/payments/intents/${a.intent.intentId}`, b),
      await e2e.post(`/payments/intents/${a.intent.intentId}/cancel`, b),
      await e2e.post(`/payments/intents/${a.intent.intentId}/pay-link`, b),
      await e2e.pay(a.intent.intentId, tokenOf(bIntent.redirectUrl)), // B's own token, A's intent
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await e2e.get(`/payments/intents/${a.intent.intentId}`, null)).status).toBe(401);
    const list = (await e2e.get('/payments/intents', b)).body.data as { intentId: string }[];
    expect(list.map((i) => i.intentId)).toEqual([bIntent.intentId]);

    // A is credited; B is untouched and still cannot see A's request.
    await settleIntent(e2e, {
      intentId: a.intent.intentId,
      userId: a.user.id,
      cardId: a.card.id,
      last4: a.card.last4,
      amountTiyin: a.amount,
      late: false,
    });
    expect(await walletOf(a.user)).toBe(a.amount.toString());
    expect(await walletOf(b)).toBe('0');
    expect(((await e2e.get('/me/ledger', b)).body.data as unknown[]).length).toBe(0);
    expect((await e2e.get(`/payments/intents/${a.intent.intentId}`, b)).status).toBe(404);
  });

  it('a request that expired is credited inside its grace window and the user is told it was a late payment', async () => {
    // An EXPIRED request cannot be produced in real time (the row is immutable in createdAt and
    // expiresAt), so it is written as the expiry sweep leaves it: 10 minutes past its deadline,
    // its amount still reserved for the 24 h grace.
    const card = await e2e.card({ bank: 'UZCARD' });
    const user = await login();
    const createdAt = new Date(Date.now() - 40 * MINUTE);
    const intentId = await e2e.fixtureIntent(user.id, {
      cardId: card.id,
      baseTiyin: 2_000_000n,
      suffixSom: 123,
      status: 'EXPIRED',
      createdAt,
      reservedUntil: new Date(createdAt.getTime() + 30 * MINUTE + 24 * HOUR),
    });
    const amount = 2_012_300n;
    const paymentId = await settleIntent(e2e, {
      intentId,
      userId: user.id,
      cardId: card.id,
      last4: card.last4,
      amountTiyin: amount,
      late: true,
    });
    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(row.status).toBe('PAID');
    expect(await walletOf(user)).toBe(amount.toString());
    expect(await ledgerSum(user.id)).toBe(amount);
    expect(await deliver(`topup-${paymentId}`)).toEqual({
      kind: 'TOPUP_LATE_CREDITED',
      refId: paymentId,
    });
    expect(flat(sender.deliveriesTo(user.telegramId.toString())[0]?.job.text ?? '')).toContain(
      flat(formatMoney(amount, 'uz')),
    );
  });
});
