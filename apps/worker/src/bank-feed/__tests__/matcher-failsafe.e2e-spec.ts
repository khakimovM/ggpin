import { DelayedError } from 'bullmq';
import { MAX_PREDECESSOR_WAITS, PREDECESSOR_WAIT_MS } from '../bank-message.processor';
import { PredecessorPendingError } from '../matcher.service';
import { useMatcherE2e } from './matcher-e2e.harness';
import {
  HOUR,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { fakeJob } from './test-seams';

const t = useMatcherE2e();

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

async function isPaused(cardId: string): Promise<boolean> {
  return (await t.db.topupCard.findUniqueOrThrow({ where: { id: cardId } })).autoCreditPaused;
}

/** A user, an ACTIVE card, a PENDING intent and the CREDIT message that pays it. */
async function paidScenario() {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const intent = await createIntent(t.db, user.id, card.id, { amountTiyin });
  const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 90_000_000n });
  return { user, card, intent, message };
}

describe('matcher: fail-closed paths (code #1, #5)', () => {
  it('a late payment whose amount was meanwhile given to a newer request is AMBIGUOUS / AMOUNT_REALLOCATED', async () => {
    const [first, second] = [await createUser(t.db), await createUser(t.db)];
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    // A: created 30 h ago, expired 29.5 h ago, reserved until 5.5 h ago. The money came 6 h ago
    // (inside A's reservation) but is processed only now. B got the same amount 5 h ago, after
    // A's reservation ended. Crediting A would extend A to tgDate + 24 h, over B (23P01).
    const old = await createIntent(t.db, first.id, card.id, {
      amountTiyin,
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 30 * HOUR),
    });
    const newer = await createIntent(t.db, second.id, card.id, {
      amountTiyin,
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 5 * HOUR),
    });
    const message = await insertMessage(t.db, {
      card,
      amountTiyin,
      balanceAfterTiyin: 7n,
      tgDate: new Date(Date.now() - 6 * HOUR),
    });
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    const outcome = await t.outcome(message.id);
    expect(outcome?.outcome).toBe('REVIEW');
    expect(outcome?.review).toMatchObject({
      kind: 'AMBIGUOUS',
      note: 'AMOUNT_REALLOCATED',
      intentId: old.id,
    });
    const intents = await t.db.paymentIntent.findMany({
      where: { id: { in: [old.id, newer.id] } },
    });
    expect(intents.map((i) => i.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(await t.ledger(first.id)).toHaveLength(0);
    expect(await t.ledger(second.id)).toHaveLength(0);
    // Its own text: "the amount was already given to another request" (N2).
    expect(await alertExists('amountReallocated', outcome?.review?.id ?? '')).toBe(true);
    expect(await alertExists('ambiguous', outcome?.review?.id ?? '')).toBe(false);
  });

  it('an unexpected error (an exclusion violation here) on the LAST attempt fails closed: review, pause, alert', async () => {
    const { user, card, intent, message } = await paidScenario();
    // 23P01 is never "settled by another processor": only P2002 with an outcome is.
    t.a.hooks.beforeCommitFn = () =>
      Promise.reject(Object.assign(new Error('exclusion violation'), { code: '23P01' }));
    const processor = t.a.processor;
    const early = fakeJob({ bankMessageId: message.id }, 0);
    await expect(processor.process(early)).rejects.toThrow('exclusion violation');
    expect(await t.outcome(message.id)).toBeNull();

    const last = fakeJob({ bankMessageId: message.id }, 4);
    await expect(processor.process(last)).resolves.toBe('FAILED_CLOSED');
    const outcome = await t.outcome(message.id);
    expect(outcome).toMatchObject({ outcome: 'REVIEW', chainStatus: 'NOT_APPLICABLE' });
    expect(outcome?.review).toMatchObject({
      kind: 'UNRECOGNIZED',
      note: 'PROCESSING_FAILED',
      cardId: card.id,
    });
    expect(await isPaused(card.id)).toBe(true);
    expect(await t.ledger(user.id)).toHaveLength(0);
    expect((await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      'PENDING',
    );
    // Its own alert with the card and "auto-credit stopped" (m-1), not the generic one.
    expect(await alertExists('processingFailed', outcome?.review?.id ?? '')).toBe(true);
    expect(await alertExists('unrecognized', outcome?.review?.id ?? '')).toBe(false);
    // A later run of the job finds the outcome and does nothing more.
    t.a.hooks.reset();
    await expect(processor.process(fakeJob({ bankMessageId: message.id }, 0))).resolves.toBe(
      'ALREADY_PROCESSED',
    );
  });

  it('waiting for an earlier message delays the job without spending attempts, then reviews and pauses', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    await createIntent(t.db, user.id, card.id, { amountTiyin });
    await insertMessage(t.db, { card, amountTiyin: 100n, balanceAfterTiyin: 1_000n });
    const later = await insertMessage(t.db, {
      card,
      amountTiyin,
      balanceAfterTiyin: 1_000n + amountTiyin,
    });
    await expect(t.a.matcher.process(later.id, false)).rejects.toBeInstanceOf(
      PredecessorPendingError,
    );

    const processor = t.a.processor;
    // Even the last normal attempt waits: the predecessor wait has its own budget.
    const job = fakeJob({ bankMessageId: later.id }, 4);
    const before = Date.now();
    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(job.data).toEqual({ bankMessageId: later.id, predecessorWaits: 1 });
    expect(job.delayedUntil ?? 0).toBeGreaterThanOrEqual(before + PREDECESSOR_WAIT_MS);
    expect(job.attemptsMade).toBe(4);
    expect(await t.outcome(later.id)).toBeNull();
    expect(MAX_PREDECESSOR_WAITS * PREDECESSOR_WAIT_MS).toBe(10 * 60_000);

    const waitedOut = fakeJob(
      { bankMessageId: later.id, predecessorWaits: MAX_PREDECESSOR_WAITS },
      0,
    );
    await expect(processor.process(waitedOut)).resolves.toBe('PROCESSED');
    const outcome = await t.outcome(later.id);
    expect(outcome).toMatchObject({ outcome: 'REVIEW', chainStatus: 'BREAK' });
    expect(outcome?.review).toMatchObject({ kind: 'CHAIN_BREAK', note: 'PREDECESSOR_PENDING' });
    expect(await isPaused(card.id)).toBe(true);
    expect(await t.ledger(user.id)).toHaveLength(0);
  });

  it('nit: when delaying the job itself fails on the LAST attempt, the message still fails closed', async () => {
    const card = await createCard(t.db);
    await insertMessage(t.db, { card, amountTiyin: 100n, balanceAfterTiyin: 1_000n });
    const later = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 90_000_000n,
    });
    const job = fakeJob({ bankMessageId: later.id }, 4);
    job.moveToDelayed = () => Promise.reject(new Error('redis down'));
    await expect(t.a.processor.process(job)).resolves.toBe('FAILED_CLOSED');
    const review = (await t.outcome(later.id))?.review;
    expect(review).toMatchObject({ kind: 'UNRECOGNIZED', note: 'PROCESSING_FAILED' });
    expect(await isPaused(card.id)).toBe(true);
    expect(await alertExists('processingFailed', review?.id ?? '')).toBe(true);
  });

  it('rejects a malformed job payload without retrying', async () => {
    const processor = t.a.processor;
    for (const data of [
      { bankMessageId: 'x:y' },
      { bankMessageId: 'cm0000000000000000000000', predecessorWaits: MAX_PREDECESSOR_WAITS + 1 },
    ]) {
      await expect(processor.process(fakeJob(data, 0))).rejects.toThrow(
        'invalid bank-message payload',
      );
    }
  });
});
