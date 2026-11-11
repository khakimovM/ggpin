import { lockWallet, type Tx } from '@repo/db';
import { bankMessageJobId, notifyJobId } from '@repo/shared';
import {
  bootReconcileWorker,
  type ReconcileWorker,
} from '../../reconcile/__tests__/reconcile-e2e.harness';
import { bankMessageJobSchema } from '../bank-message.processor';
import { OUTCOME_SETTLE_MS } from '../orphan-requeue.service';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  MINUTE,
  SENDER_ID,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { waitForBlockedSession } from './test-seams';

// D-47 R1 (owner decision A) on the real ggpin_test DB: when the owner credited the user by hand
// after the request was made (a positive ADJUSTMENT from wallet:adjust, or the TOPUP of a
// review:credit), the matched transfer is never credited automatically: review AMBIGUOUS /
// MANUAL_CREDIT_SEEN and an owner alert. Messages here are stored ON TIME (5 s after their date),
// so D-47's late rule does not apply: this check guards every automatic credit.
const t = useMatcherE2e();
let w: ReconcileWorker;
const LIVE = ['waiting', 'delayed', 'prioritized', 'paused'] as const;
let liveBefore = new Set<string>();

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
  liveBefore = new Set((await w.bankMessages.getJobs([...LIVE])).map((j) => j.id ?? ''));
});

afterAll(async () => {
  // The orphan sweep re-queues undecided messages of the shared DB; nothing consumes them here.
  for (const job of await w.bankMessages.getJobs([...LIVE])) {
    if (!liveBefore.has(job.id ?? '')) await job.remove();
  }
  await w.close();
});

/** A user, a card, one request (created 20 min ago) and the CREDIT that pays it, on time. */
async function scenario(status: 'PENDING' | 'EXPIRED' = 'PENDING') {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const createdAt = new Date(Date.now() - (status === 'EXPIRED' ? 50 : 20) * MINUTE);
  const intent = await createIntent(t.db, user.id, card.id, { amountTiyin, status, createdAt });
  const tgDate = new Date(Date.now() - 15 * MINUTE);
  const message = await insertMessage(t.db, {
    card,
    amountTiyin,
    balanceAfterTiyin: 30_000_000n,
    tgDate,
    storedAt: new Date(tgDate.getTime() + 5_000),
  });
  return { user, card, intent, message };
}

/** What wallet:adjust writes, under the same Wallet lock (synthetic reason and actor). */
async function writeAdjustment(tx: Tx, userId: string, amountTiyin: bigint, at?: Date) {
  await lockWallet(tx, userId);
  const audit = await tx.auditLog.create({
    data: { actorType: 'CLI', action: 'WALLET_ADJUST', targetType: 'User', targetId: userId },
  });
  await tx.ledgerEntry.create({
    data: {
      userId,
      kind: 'ADJUSTMENT',
      amountTiyin,
      refType: 'ADMIN_ACTION',
      refId: audit.id,
      note: 'e2e hand credit',
      ...(at === undefined ? {} : { createdAt: at }),
    },
  });
}

function adjustByHand(userId: string, amountTiyin: bigint, at?: Date) {
  return t.db.$transaction((tx) => writeAdjustment(tx, userId, amountTiyin, at));
}

/**
 * What review:credit writes for another transfer of the user (a NO_MATCH review on another
 * card): Payment with reviewId + TOPUP PAYMENT/<paymentId>, the review resolved. Intentless.
 */
async function reviewCreditByHand(userId: string, amount: bigint = uniqueAmount()) {
  const card = await createCard(t.db);
  const other = await insertMessage(t.db, {
    card,
    amountTiyin: amount,
    balanceAfterTiyin: amount + 4_000_000n,
  });
  await t.a.matcher.process(other.id, false);
  const review = (await t.outcome(other.id))?.review;
  if (review == null || other.amountTiyin === null) throw new Error('no NO_MATCH review');
  const amountTiyin = other.amountTiyin;
  await t.db.$transaction(async (tx) => {
    await lockWallet(tx, userId);
    const now = new Date();
    const payment = await tx.payment.create({
      data: {
        userId,
        provider: 'P2P_CARD',
        providerTxnId: `${SENDER_ID.toString()}:${other.tgMessageId.toString()}`,
        amountTiyin,
        status: 'CONFIRMED',
        bankMessageId: other.id,
        reviewId: review.id,
        confirmedAt: now,
        raw: { via: 'REVIEW' },
      },
    });
    await tx.ledgerEntry.create({
      data: { userId, kind: 'TOPUP', amountTiyin, refType: 'PAYMENT', refId: payment.id },
    });
    const audit = await tx.auditLog.create({
      data: {
        actorType: 'CLI',
        action: 'REVIEW_CREDIT',
        targetType: 'PaymentReview',
        targetId: review.id,
      },
    });
    await tx.paymentReview.update({
      where: { id: review.id },
      data: {
        status: 'RESOLVED',
        resolution: 'CREDITED_USER',
        resolvedAuditLogId: audit.id,
        resolvedAt: now,
      },
    });
  });
}

async function expectManualCreditSeen(s: Awaited<ReturnType<typeof scenario>>) {
  const outcome = await t.outcome(s.message.id);
  expect(outcome).toMatchObject({ outcome: 'REVIEW', payment: null });
  expect(outcome?.review).toMatchObject({
    kind: 'AMBIGUOUS',
    note: 'MANUAL_CREDIT_SEEN',
    intentId: s.intent.id,
    cardId: s.card.id,
    status: 'OPEN',
  });
  const refId = outcome?.review?.id ?? '';
  const alert = notifyJobId({ kind: 'OWNER_ALERT', alert: 'manualCreditSeen', refId });
  expect((await t.notifyJob(alert))?.data).toEqual({
    kind: 'OWNER_ALERT',
    alert: 'manualCreditSeen',
    refId,
  });
}

const topups = async (userId: string) =>
  (await t.ledger(userId)).filter((entry) => entry.kind === 'TOPUP');

/** Opens a gate that a test awaits. */
function gate() {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open: () => open(), opened };
}

describe('matcher: a hand credit after the request blocks the automatic credit (D-47 R1)', () => {
  it('STUCK, wallet:adjust, then the orphan re-queue: review MANUAL_CREDIT_SEEN, no second TOPUP', async () => {
    const s = await scenario('PENDING');
    // The message is stuck (no outcome); after messageStuck the owner pays the user by hand.
    await adjustByHand(s.user.id, s.message.amountTiyin ?? 0n);
    const later = new Date(Date.now() + OUTCOME_SETTLE_MS + MINUTE);
    await w.expire.run(later);
    const job = await w.bankMessages.getJob(bankMessageJobId(s.message.id));
    const data = bankMessageJobSchema.parse(job?.data);
    expect(data).toEqual({ bankMessageId: s.message.id });
    await expect(t.a.matcher.process(data.bankMessageId, false)).resolves.toBe('PROCESSED');

    await expectManualCreditSeen(s);
    expect(await topups(s.user.id)).toHaveLength(0);
    expect((await t.ledger(s.user.id)).map((e) => e.kind)).toEqual(['ADJUSTMENT']);
    const intent = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: s.intent.id } });
    expect(intent.status).not.toBe('PAID');
  });

  it('an adjustment made before the request does not count: credited', async () => {
    const s = await scenario('EXPIRED');
    await adjustByHand(s.user.id, 900_000n, new Date(s.intent.createdAt.getTime() - MINUTE));
    await t.a.matcher.process(s.message.id, false);
    expect((await t.outcome(s.message.id))?.outcome).toBe('CREDITED');
    expect(await topups(s.user.id)).toHaveLength(1);
  });

  it('a negative adjustment after the request does not count: credited', async () => {
    const s = await scenario('PENDING');
    await adjustByHand(s.user.id, -200_000n);
    await t.a.matcher.process(s.message.id, false);
    expect((await t.outcome(s.message.id))?.outcome).toBe('CREDITED');
  });

  it('a review:credit of another transfer after the request: review MANUAL_CREDIT_SEEN (EXPIRED in grace)', async () => {
    const s = await scenario('EXPIRED');
    await reviewCreditByHand(s.user.id);
    await t.a.matcher.process(s.message.id, false);
    await expectManualCreditSeen(s);
    expect(await topups(s.user.id)).toHaveLength(1); // only the hand-credited one
  });

  it('D-54: an intentless review:credit counts toward the daily cap: DAILY_LIMIT comes first', async () => {
    // A new account; the owner credits a 460 000 so'm NO_MATCH transfer by hand, then this
    // ~50 000 so'm request (base 50 000) arrives: 510 000 so'm > the 500 000 so'm cap. Without
    // D-54 the hand credit would not count and only MANUAL_CREDIT_SEEN would stop it.
    const s = await scenario('PENDING');
    await reviewCreditByHand(s.user.id, 46_000_000n);
    await t.a.matcher.process(s.message.id, false);
    const outcome = await t.outcome(s.message.id);
    expect(outcome).toMatchObject({ outcome: 'REVIEW', payment: null });
    expect(outcome?.review).toMatchObject({
      kind: 'DAILY_LIMIT',
      note: 'NEW_ACCOUNT_DAILY_LIMIT',
      intentId: s.intent.id,
    });
    expect(await topups(s.user.id)).toHaveLength(1); // only the hand-credited one
  });

  it('an automatic credit of another request after this one was made does not count', async () => {
    const s = await scenario('PENDING');
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const createdAt = new Date(Date.now() - 50 * MINUTE);
    const opts = { amountTiyin, status: 'EXPIRED', createdAt } as const;
    await createIntent(t.db, s.user.id, card.id, opts);
    const first = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7_000_000n });
    await t.a.matcher.process(first.id, false);
    expect((await t.outcome(first.id))?.outcome).toBe('CREDITED');
    await t.a.matcher.process(s.message.id, false);
    expect((await t.outcome(s.message.id))?.outcome).toBe('CREDITED');
    expect(await topups(s.user.id)).toHaveLength(2);
  });

  it('adjust and matcher at once, adjust first: the matcher waits on the Wallet lock, then reviews', async () => {
    const s = await scenario('PENDING');
    const held = gate();
    const adjusting = t.db.$transaction(async (tx) => {
      await writeAdjustment(tx, s.user.id, 1_000_000n);
      held.open();
      await waitForBlockedSession(tx, 'myTransaction'); // the matcher waits for this commit
    });
    await held.opened;
    const processing = t.a.matcher.process(s.message.id, false);
    await Promise.all([adjusting, processing]);

    await expectManualCreditSeen(s);
    expect((await t.ledger(s.user.id)).map((e) => e.kind)).toEqual(['ADJUSTMENT']);
  });

  it('matcher first: the adjust waits until the credit commits (one credit each, in order)', async () => {
    // The residual case of docs/05 §7: a hand credit AFTER the automatic one cannot be refused
    // here; the owner already got the CREDITED payment (and wallet:adjust shows the balance).
    const s = await scenario('PENDING');
    const held = gate();
    t.a.hooks.beforeCommitFn = async (tx) => {
      held.open();
      await waitForBlockedSession(tx, 'myTransaction');
    };
    const processing = t.a.matcher.process(s.message.id, false);
    await held.opened;
    await Promise.all([processing, adjustByHand(s.user.id, 1_000_000n)]);
    expect((await t.outcome(s.message.id))?.outcome).toBe('CREDITED');
    expect((await t.ledger(s.user.id)).map((e) => e.kind)).toEqual(['TOPUP', 'ADJUSTMENT']);
  });
});
