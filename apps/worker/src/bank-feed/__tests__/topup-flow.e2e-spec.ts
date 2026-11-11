import { bankMessageJobId, reviewAlertOf, walletCacheKey } from '@repo/shared';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../reconcile/__tests__/reconcile-e2e.harness';
import type { BankFeedMessage } from '../client/bank-feed-client';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  MINUTE,
  SENDER_ID,
  createCard,
  createIntent,
  createUser,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { uzcardText } from './synthetic-message';

// The worker half of the P2P top-up on the real ggpin_test Postgres and Redis DB 15: a bank
// message appears in the FAKE bank chat (the in-memory client BANK_FEED_MODE=fake stands for) ->
// it is read back through the client contract and stored by the ordinary ingest path, which
// queues the `bank-message` job -> that queued job goes through the real BankMessageProcessor and
// matcher -> TOPUP in the ledger, wallet cache dropped, `notify` job queued. The API half
// (login, intent, pay page, notify -> tg-outbox -> /me/wallet) is apps/api .../topup-flow.e2e-spec.ts;
// the API may not import worker code and the worker may not import the API, so the two halves
// meet at the database rows and the queue job, exactly as in production. No BullMQ Worker runs;
// nothing reaches Telegram or a bank; every bank value is SYNTHETIC.
const t = useMatcherE2e();
let w: ReconcileWorker;
const stored: string[] = [];
let seq = BigInt(Date.now()) * 1_000n + 700_000_000n;

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
});

afterAll(async () => {
  await w.removeBankMessageJobs(stored);
  await w.close();
});

const message = (last4: string, amountTiyin: bigint, id: bigint = (seq += 1n)): BankFeedMessage => {
  const date = new Date(Date.now() - MINUTE);
  return {
    id,
    date,
    chatId: SENDER_ID,
    senderId: SENDER_ID,
    senderIsBot: true,
    text: uzcardText({
      direction: 'CREDIT',
      amountTiyin,
      balanceAfterTiyin: 60_000_000n,
      last4,
      bankTxnAt: date,
    }),
    outgoing: false,
    forwarded: false,
    editDate: null,
    viaBotId: null,
  };
};

/** The message reaches the fake chat, is read back with the client contract and ingested. */
async function receive(m: BankFeedMessage) {
  w.client.clear();
  w.client.put('UZCARD_BOT', m);
  const [fetched] = await w.client.fetchSince('UZCARD_BOT', m.id - 1n, 1);
  if (fetched === undefined) throw new Error('the fake chat returned nothing');
  const result = await w.ingest.ingest('UZCARD_BOT', fetched);
  if (result.stored) stored.push(result.bankMessageId);
  return result;
}

/** What the BullMQ worker would do: take the queued `bank-message` job and run the processor. */
async function runQueuedJob(bankMessageId: string) {
  const job = await w.bankMessages.getJob(bankMessageJobId(bankMessageId));
  if (job === undefined) throw new Error('no bank-message job was queued');
  return t.a.processor.process(job);
}

async function scenario(status: 'PENDING' | 'EXPIRED', createdAgoMin: number) {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const intent = await createIntent(t.db, user.id, card.id, {
    amountTiyin,
    status,
    createdAt: new Date(Date.now() - createdAgoMin * MINUTE),
  });
  return { user, card, intent, amountTiyin };
}

describe('P2P top-up, the worker half of the flow (fake bank feed)', () => {
  it('fake chat -> ingest -> queued job -> processor -> TOPUP -> cache DEL -> notify job', async () => {
    const { user, card, intent, amountTiyin } = await scenario('PENDING', 5);
    await t.redis.client.set(walletCacheKey(user.id), '0');

    const result = await receive(message(card.last4, amountTiyin));
    expect(result).toMatchObject({ stored: true });
    const id = result.stored ? result.bankMessageId : '';
    // Stored and queued, but nothing is decided or credited until the job runs.
    expect(await w.bankMessages.getJob(bankMessageJobId(id))).toBeDefined();
    expect(await t.outcome(id)).toBeNull();
    expect(await t.ledger(user.id)).toHaveLength(0);

    await expect(runQueuedJob(id)).resolves.toBe('PROCESSED');
    const outcome = await t.outcome(id);
    expect(outcome).toMatchObject({ outcome: 'CREDITED', chainStatus: 'FIRST' });
    const payment = outcome?.payment;
    expect(payment).toMatchObject({ userId: user.id, status: 'CONFIRMED', amountTiyin });
    expect((await t.ledger(user.id)).map((e) => [e.kind, e.amountTiyin, e.refId])).toEqual([
      ['TOPUP', amountTiyin, payment?.id],
    ]);
    const row = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.status).toBe('PAID');
    expect(await t.redis.client.exists(walletCacheKey(user.id))).toBe(0);
    const job = await t.notifyJob(`topup-${payment?.id ?? ''}`);
    expect(job?.data).toEqual({ kind: 'TOPUP_CREDITED', refId: payment?.id });
  });

  it('the same message again, and the same job three times: ONE TOPUP and ONE notify job', async () => {
    const { user, card, amountTiyin } = await scenario('PENDING', 5);
    const m = message(card.last4, amountTiyin);
    const first = await receive(m);
    const id = first.stored ? first.bankMessageId : '';
    await expect(runQueuedJob(id)).resolves.toBe('PROCESSED');

    await expect(receive(m)).resolves.toEqual({ stored: false, reason: 'DUPLICATE' });
    await expect(runQueuedJob(id)).resolves.toBe('ALREADY_PROCESSED');
    await expect(runQueuedJob(id)).resolves.toBe('ALREADY_PROCESSED');

    expect(await t.ledger(user.id)).toHaveLength(1);
    expect(await t.db.payment.count({ where: { bankMessageId: id } })).toBe(1);
    expect(
      await t.db.bankMessage.count({ where: { senderId: SENDER_ID, tgMessageId: m.id } }),
    ).toBe(1);
    const payment = await t.db.payment.findUniqueOrThrow({ where: { bankMessageId: id } });
    expect((await t.notifyJob(`topup-${payment.id}`))?.data).toMatchObject({ refId: payment.id });
  });

  it('a wrong amount credits nothing: a NO_MATCH review, the request stays PENDING, the owner is alerted', async () => {
    const { user, card, intent, amountTiyin } = await scenario('PENDING', 5);
    const result = await receive(message(card.last4, amountTiyin + 100n)); // one so'm too much
    const id = result.stored ? result.bankMessageId : '';
    await expect(runQueuedJob(id)).resolves.toBe('PROCESSED');

    const outcome = await t.outcome(id);
    expect(outcome?.payment).toBeNull();
    expect(outcome?.review).toMatchObject({ kind: 'NO_MATCH', status: 'OPEN' });
    expect(await t.ledger(user.id)).toHaveLength(0);
    const row = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.status).toBe('PENDING');
    const review = outcome?.review;
    const alert = reviewAlertOf('NO_MATCH', review?.note ?? null, true);
    const job = await t.notifyJob(`alert-${alert}-${review?.id ?? ''}`);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert, refId: review?.id });
  });

  it('a request that expired is credited inside its grace window and queued as a LATE credit', async () => {
    const { user, card, intent, amountTiyin } = await scenario('EXPIRED', 40);
    const result = await receive(message(card.last4, amountTiyin));
    const id = result.stored ? result.bankMessageId : '';
    await expect(runQueuedJob(id)).resolves.toBe('PROCESSED');

    const outcome = await t.outcome(id);
    expect(outcome).toMatchObject({ outcome: 'CREDITED' });
    expect((await t.ledger(user.id)).map((e) => [e.kind, e.amountTiyin])).toEqual([
      ['TOPUP', amountTiyin],
    ]);
    const row = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(row.status).toBe('PAID');
    const job = await t.notifyJob(`topup-${outcome?.payment?.id ?? ''}`);
    expect(job?.data).toEqual({ kind: 'TOPUP_LATE_CREDITED', refId: outcome?.payment?.id });
  });
});
