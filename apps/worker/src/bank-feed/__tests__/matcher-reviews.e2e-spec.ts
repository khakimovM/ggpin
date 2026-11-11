import { useMatcherE2e } from './matcher-e2e.harness';
import {
  HOUR,
  MINUTE,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  insertUnparsed,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { waitForBlockedSession } from './test-seams';

const t = useMatcherE2e();

/** Processes `messageId`, asserts nothing reached the given wallets and returns its review. */
async function reviewOf(messageId: string, userIds: readonly string[] = []) {
  await t.a.matcher.process(messageId, false);
  const outcome = await t.outcome(messageId);
  expect(outcome?.outcome).toBe('REVIEW');
  for (const userId of userIds) expect(await t.ledger(userId)).toHaveLength(0);
  const review = outcome?.review;
  if (review === null || review === undefined) throw new Error('no review');
  return review;
}

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

describe('matcher: nothing doubtful is credited (review + owner alert)', () => {
  it.each([
    ['UNRECOGNIZED', 'unrecognized'],
    ['REJECTED', 'rejected'],
  ] as const)('a %s message', async (status, alert) => {
    const message = await insertUnparsed(t.db, status, 'AMOUNT_FORMAT');
    const review = await reviewOf(message.id);
    expect(review.kind).toBe(status);
    expect(await alertExists(alert, review.id)).toBe(true);
  });

  it('a message for no known card is CARD_UNKNOWN', async () => {
    const message = await insertMessage(t.db, {
      card: null,
      last4: '0000',
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 1n,
    });
    expect((await reviewOf(message.id)).kind).toBe('CARD_UNKNOWN');
  });

  it('two workers on a card-less message: B hits the unique key, rolls back, and reports "already"', async () => {
    const message = await insertMessage(t.db, {
      card: null,
      last4: '0001',
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 1n,
    });
    // A has written its review and, before committing, starts B and waits until pg_locks shows
    // B's INSERT blocked on A's transaction: B then gets P2002 when A commits (no card lock
    // serialises card-less messages).
    let second: Promise<string> | undefined;
    t.a.hooks.beforeCommitFn = async (tx) => {
      second = t.b.matcher.process(message.id, false);
      await waitForBlockedSession(tx, 'myTransaction');
    };
    const settled: string[] = [];
    t.b.hooks.settledByOtherFn = (id) => {
      settled.push(id);
      return Promise.resolve();
    };
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    await expect(second).resolves.toBe('ALREADY_PROCESSED');
    expect(settled).toEqual([message.id]);
    expect(await t.db.paymentReview.count({ where: { bankMessageId: message.id } })).toBe(1);
  });

  it('a message for a RETIRED card is CARD_RETIRED', async () => {
    const card = await createCard(t.db);
    await t.db.topupCard.update({
      where: { id: card.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    const message = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 1n,
    });
    const review = await reviewOf(message.id);
    expect(review.kind).toBe('CARD_RETIRED');
    expect(await alertExists('cardRetired', review.id)).toBe(true);
  });

  it('bank time far from Telegram time is TIME_SKEW', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    await createIntent(t.db, user.id, card.id, { amountTiyin });
    const tgDate = new Date(Date.now() - MINUTE);
    const message = await insertMessage(t.db, {
      card,
      amountTiyin,
      balanceAfterTiyin: 5n * amountTiyin,
      tgDate,
      bankTxnAt: new Date(tgDate.getTime() - 20 * MINUTE),
    });
    expect((await reviewOf(message.id, [user.id])).kind).toBe('TIME_SKEW');
  });

  it('a second payment of an amount that was already PAID is DUPLICATE', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const paid = await createIntent(t.db, user.id, card.id, { amountTiyin, status: 'PAID' });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n });
    const review = await reviewOf(message.id, [user.id]);
    expect(review).toMatchObject({ kind: 'DUPLICATE', intentId: paid.id });
    expect(await alertExists('duplicate', review.id)).toBe(true);
  });

  it('an amount nobody waits for is NO_MATCH', async () => {
    const card = await createCard(t.db);
    const message = await insertMessage(t.db, {
      card,
      amountTiyin: uniqueAmount(),
      balanceAfterTiyin: 7n,
    });
    expect((await reviewOf(message.id)).kind).toBe('NO_MATCH');
  });

  it('two candidates (artificially, non-overlapping reservations) are AMBIGUOUS', async () => {
    const [u1, u2] = [await createUser(t.db), await createUser(t.db)];
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const tgDate = new Date(Date.now() - 10 * MINUTE);
    // A's reservation ends 30 s after the message, B is created 60 s after it: the EXCLUDE
    // constraint sees two disjoint ranges, the matcher sees two candidates.
    const a = await t.db.paymentIntent.create({
      data: {
        userId: u1.id,
        provider: 'P2P_CARD',
        cardId: card.id,
        amountTiyin,
        baseAmountTiyin: 5_000_000n,
        status: 'EXPIRED',
        purpose: 'TOPUP',
        idempotencyKey: `amb-${amountTiyin.toString()}`,
        requestHash: 'h',
        createdAt: new Date(tgDate.getTime() - 10 * HOUR),
        expiresAt: new Date(tgDate.getTime() + 20_000),
        reservedUntil: new Date(tgDate.getTime() + 30_000),
      },
    });
    const b = await createIntent(t.db, u2.id, card.id, {
      amountTiyin,
      createdAt: new Date(tgDate.getTime() + 60_000),
    });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n, tgDate });
    const review = await reviewOf(message.id, [u1.id, u2.id]);
    expect(review.kind).toBe('AMBIGUOUS');
    const after = await t.db.paymentIntent.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(after.map((i) => i.status).sort()).toEqual(['EXPIRED', 'PENDING']);
  });

  it('money for a CANCELLED intent is CANCELLED_LATE, never credited', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const intent = await createIntent(t.db, user.id, card.id, { amountTiyin, status: 'CANCELLED' });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n });
    expect(await reviewOf(message.id, [user.id])).toMatchObject({
      kind: 'CANCELLED_LATE',
      intentId: intent.id,
    });
  });

  it('m-4: an intent the API cancels between the first verdict and the intent lock is CANCELLED_LATE', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const intent = await createIntent(t.db, user.id, card.id, { amountTiyin });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n });
    const seen: string[] = [];
    // Runs after the first verdict said CREDIT and before FOR UPDATE: the user cancels now
    // (another connection, committed), so only the re-verdict on the locked row can catch it.
    t.a.hooks.beforeIntentLockFn = async (_tx, intentId) => {
      seen.push(intentId);
      await t.db.paymentIntent.update({
        where: { id: intentId },
        data: { status: 'CANCELLED' },
      });
    };
    expect(await reviewOf(message.id, [user.id])).toMatchObject({
      kind: 'CANCELLED_LATE',
      intentId: intent.id,
    });
    expect(seen).toEqual([intent.id]);
    const after = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe('CANCELLED');
    expect(await t.db.payment.count({ where: { intentId: intent.id } })).toBe(0);
  });

  it('a blocked user is USER_BLOCKED', async () => {
    const user = await createUser(t.db, { isBlocked: true });
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    await createIntent(t.db, user.id, card.id, { amountTiyin });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n });
    expect((await reviewOf(message.id, [user.id])).kind).toBe('USER_BLOCKED');
  });

  it('a new account over its daily cap at credit time is DAILY_LIMIT (which cap in the note)', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    // 460 000 so'm already paid today + this 50 000 so'm request = over the 500 000 cap.
    await createIntent(t.db, user.id, card.id, {
      amountTiyin: 46_000_100n,
      baseAmountTiyin: 46_000_000n,
      status: 'PAID',
      createdAt: new Date(Date.now() - HOUR),
    });
    const amountTiyin = uniqueAmount();
    await createIntent(t.db, user.id, card.id, { amountTiyin });
    const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 7n });
    const review = await reviewOf(message.id, [user.id]);
    expect(review).toMatchObject({ kind: 'DAILY_LIMIT', note: 'NEW_ACCOUNT_DAILY_LIMIT' });
  });

  it('D-43: an exact match whose title is unknown is reviewed (UNRECOGNIZED + TITLE_UNKNOWN), no ledger', async () => {
    const user = await createUser(t.db);
    const card = await createCard(t.db);
    const amountTiyin = uniqueAmount();
    const intent = await createIntent(t.db, user.id, card.id, { amountTiyin });
    const message = await insertMessage(t.db, {
      card,
      amountTiyin,
      balanceAfterTiyin: 7n,
      title: 'Uvedomlenie TEST',
    });
    const review = await reviewOf(message.id, [user.id]);
    expect(review).toMatchObject({
      kind: 'UNRECOGNIZED',
      note: 'TITLE_UNKNOWN',
      intentId: intent.id,
    });
    expect((await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      'PENDING',
    );
    // Its own alert (code #8), not the generic "unrecognized" one.
    expect(await alertExists('titleUnknown', review.id)).toBe(true);
    expect(await alertExists('unrecognized', review.id)).toBe(false);
  });
});
