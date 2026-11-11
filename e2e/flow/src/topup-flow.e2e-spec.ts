import {
  PayViewSchema,
  QUEUES,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  formatMoney,
  notifyJobSchema,
  walletCacheKey,
} from '@repo/shared';
import { Queue } from 'bullmq';
import { FakeSender } from '../../../apps/api/src/modules/notifications/__tests__/tg-outbox.e2e-helpers';
import { TG_OUTBOX_SENDER } from '../../../apps/api/src/modules/notifications/tg-outbox.sender';
import {
  HOUR,
  MINUTE,
  tokenOf,
  usePaymentsE2e,
} from '../../../apps/api/src/modules/payments/__tests__/payments-e2e.helpers';
import { flat, flowKit } from '../../../apps/api/src/modules/payments/__tests__/topup-flow.helpers';
import { WorkerSide } from './worker-side';

// The whole P2P top-up in ONE process on the real ggpin_test Postgres and Redis DB 15 (the API
// and the worker may not import each other, so this neutral workspace hosts both):
// real Mini App login -> POST /payments/intents -> GET /payments/pay/:id (X-Pay-Token) -> a bank
// message appears in the FAKE bank chat -> (the first test: the worker's listener leads, the
// update nudges its poll) -> the worker's ingest stores it and queues the
// `bank-message` job -> the real processor and matcher credit -> `notify` job -> the API's notify
// consumer -> `tg-outbox` job -> the tg-outbox consumer with a FAKE Telegram sender -> /me/wallet.
// No BullMQ Worker runs (jobs are read back by id and handed to the consumers), nothing reaches
// Telegram, a bank, Fragment or TON; every bank value is SYNTHETIC. The API app gets the API env
// only; the worker boots from its own env object.
const OWNER_CHAT = '7000000002';
const sender = new FakeSender();
const e2e = usePaymentsE2e({
  env: { OWNER_ALERT_CHAT_ID: OWNER_CHAT, MINI_APP_URL: 'https://app.ggpin.test/tg' },
  overrides: [{ provide: TG_OUTBOX_SENDER, useValue: sender }],
});
const outboxIds = new Set<string>();
const { login, walletOf, requestTopup, ledgerSum, deliver } = flowKit(e2e, outboxIds);
let worker: WorkerSide;
let outbox: Queue;

beforeAll(async () => {
  worker = await WorkerSide.boot();
  outbox = new Queue(QUEUES.TG_OUTBOX, { connection: { url: e2e.env.REDIS_URL } });
});

afterAll(async () => {
  await worker.close();
  for (const id of outboxIds) await outbox.remove(id).catch(() => 0);
  await outbox.close();
});

/** The row id of a stored message; a test that expected "stored" fails here otherwise. */
function storedId(received: Awaited<ReturnType<WorkerSide['receive']>>): string {
  if (!received.stored) throw new Error(`message not stored: ${received.reason}`);
  return received.bankMessageId;
}

describe('P2P top-up, the whole flow (fake bank feed, fake Telegram)', () => {
  it('login -> intent -> pay page -> bank message -> TOPUP -> notify -> outbox -> /me/wallet', async () => {
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

    // Through the real listener: leader lock, authorization round, update nudge, poll (L2).
    const id = await worker.receiveLive({ last4: card.last4, amountTiyin: amount });
    expect(await worker.hasJob(id)).toBe(true);
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(0); // stored, not decided
    await expect(worker.runJob(id)).resolves.toBe('PROCESSED');

    const outcome = await e2e.db().bankMessageOutcome.findUniqueOrThrow({
      where: { bankMessageId: id },
      include: { payment: true },
    });
    expect(outcome).toMatchObject({ outcome: 'CREDITED', chainStatus: 'FIRST' });
    expect(outcome.payment).toMatchObject({
      userId: user.id,
      status: 'CONFIRMED',
      amountTiyin: amount,
      intentId: intent.intentId,
    });
    const paymentId = outcome.payment?.id ?? '';
    const ledger = await e2e.db().ledgerEntry.findMany({ where: { userId: user.id } });
    expect(ledger.map((e) => [e.kind, e.amountTiyin, e.refType, e.refId])).toEqual([
      ['TOPUP', amount, 'PAYMENT', paymentId],
    ]);
    expect(await e2e.redis().exists(walletCacheKey(user.id))).toBe(0); // dropped after the commit
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

  it('the same message three times (replay, re-run, re-run): ONE TOPUP and ONE notification', async () => {
    const { card, user, amount } = await requestTopup();
    const at = new Date(Date.now() - MINUTE);
    const first = await worker.receive({ last4: card.last4, amountTiyin: amount, at });
    const id = storedId(first);
    await expect(worker.runJob(id)).resolves.toBe('PROCESSED');

    const replay = await worker.receive({
      last4: card.last4,
      amountTiyin: amount,
      at,
      tgMessageId: first.tgMessageId,
    });
    expect(replay).toMatchObject({ stored: false, reason: 'DUPLICATE' });
    await expect(worker.runJob(id)).resolves.toBe('ALREADY_PROCESSED');
    await expect(worker.runJob(id)).resolves.toBe('ALREADY_PROCESSED');

    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(1);
    const payments = await e2e.db().payment.findMany({ where: { userId: user.id } });
    expect(payments).toHaveLength(1);
    expect(await walletOf(user)).toBe(amount.toString());
    const jobs = await e2e.notifyQueue().getJobs(['waiting', 'delayed', 'completed', 'failed']);
    expect(jobs.filter((j) => j.id === `topup-${payments[0]?.id ?? ''}`)).toHaveLength(1);
  });

  it('a wrong amount credits nothing: a NO_MATCH review, the request stays PENDING, the owner is told', async () => {
    const { card, user, intent, amount } = await requestTopup();
    const id = storedId(await worker.receive({ last4: card.last4, amountTiyin: amount + 100n })); // 1 so'm too much
    await expect(worker.runJob(id)).resolves.toBe('PROCESSED');

    const outcome = await e2e.db().bankMessageOutcome.findUniqueOrThrow({
      where: { bankMessageId: id },
      include: { review: true, payment: true },
    });
    expect(outcome.payment).toBeNull();
    expect(outcome.review).toMatchObject({ kind: 'NO_MATCH', status: 'OPEN' });
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await walletOf(user)).toBe('0');
    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intent.intentId } });
    expect(row.status).toBe('PENDING');

    // The owner alert names ids and a short reason only, and goes to the owner chat.
    const jobs = await e2e.notifyQueue().getJobs(['waiting', 'delayed']);
    const alert = jobs.find((j) => {
      const data = notifyJobSchema.safeParse(j.data);
      return data.success && data.data.refId === outcome.review?.id;
    });
    expect(notifyJobSchema.parse(alert?.data)).toMatchObject({ kind: 'OWNER_ALERT' });
    await deliver(String(alert?.id));
    const text = sender.deliveriesTo(OWNER_CHAT).at(-1)?.job.text ?? '';
    expect(text).not.toContain(card.pan);
    expect(text).not.toContain('Perevod');
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

    // A is credited by the worker; B is untouched and still cannot see A's request.
    const id = storedId(await worker.receive({ last4: a.card.last4, amountTiyin: a.amount }));
    await expect(worker.runJob(id)).resolves.toBe('PROCESSED');
    expect(await walletOf(a.user)).toBe(a.amount.toString());
    expect(await walletOf(b)).toBe('0');
    expect(((await e2e.get('/me/ledger', b)).body.data as unknown[]).length).toBe(0);
    expect((await e2e.get(`/payments/intents/${a.intent.intentId}`, b)).status).toBe(404);
  });

  it('a request that expired is credited inside its grace window and the user is told it was a late payment', async () => {
    // An EXPIRED request cannot be produced in real time (createdAt and expiresAt are immutable
    // in the database), so it is written as the expiry sweep leaves it: 10 minutes past its
    // deadline, its amount still reserved for the 24 h grace.
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
    const id = storedId(await worker.receive({ last4: card.last4, amountTiyin: amount }));
    await expect(worker.runJob(id)).resolves.toBe('PROCESSED');

    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(row.status).toBe('PAID');
    const payment = await e2e.db().payment.findFirstOrThrow({ where: { userId: user.id } });
    expect(await walletOf(user)).toBe(amount.toString());
    expect(await ledgerSum(user.id)).toBe(amount);
    expect(await deliver(`topup-${payment.id}`)).toEqual({
      kind: 'TOPUP_LATE_CREDITED',
      refId: payment.id,
    });
    expect(flat(sender.deliveriesTo(user.telegramId.toString())[0]?.job.text ?? '')).toContain(
      flat(formatMoney(amount, 'uz')),
    );
  });
});
