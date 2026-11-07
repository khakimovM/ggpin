import { useMatcherE2e } from './matcher-e2e.harness';
import {
  BASE_TIYIN,
  MINUTE,
  SENDER_ID,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { waitForBlockedSession } from './test-seams';

const t = useMatcherE2e();

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

async function isPaused(cardId: string): Promise<boolean> {
  return (await t.db.topupCard.findUniqueOrThrow({ where: { id: cardId } })).autoCreditPaused;
}

/** A PENDING intent and its exact CREDIT message, with the message options given. */
async function scenario(extra: { senderId?: bigint; textSha256?: string; purgeable?: boolean }) {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const intent = await createIntent(t.db, user.id, card.id, { amountTiyin });
  const message = await insertMessage(t.db, {
    card,
    amountTiyin,
    balanceAfterTiyin: 7n,
    ...extra,
  });
  return { user, card, intent, message };
}

async function reviewOf(messageId: string) {
  await expect(t.a.matcher.process(messageId, false)).resolves.toBe('PROCESSED');
  const outcome = await t.outcome(messageId);
  expect(outcome?.outcome).toBe('REVIEW');
  const review = outcome?.review;
  if (review === null || review === undefined) throw new Error('no review');
  return review;
}

describe('matcher: stored-row integrity and races (L3, code #4, #7)', () => {
  it('a row whose sender is not the pinned bot of its source is never credited (SENDER_MISMATCH)', async () => {
    const { user, card, message } = await scenario({ senderId: SENDER_ID + 1n });
    const review = await reviewOf(message.id);
    expect(review).toMatchObject({ kind: 'UNRECOGNIZED', note: 'SENDER_MISMATCH' });
    expect(await isPaused(card.id)).toBe(true);
    expect(await t.ledger(user.id)).toHaveLength(0);
    // The security alert (N2 / m-1), not the generic "not recognised".
    expect(await alertExists('integrityAnomaly', review.id)).toBe(true);
    expect(await alertExists('unrecognized', review.id)).toBe(false);
  });

  it('a row whose raw text does not hash to textSha256 is never credited (TEXT_HASH_MISMATCH)', async () => {
    const { user, card, message } = await scenario({ textSha256: '0'.repeat(64) });
    const review = await reviewOf(message.id);
    expect(review).toMatchObject({ kind: 'UNRECOGNIZED', note: 'TEXT_HASH_MISMATCH' });
    expect(await isPaused(card.id)).toBe(true);
    expect(await t.ledger(user.id)).toHaveLength(0);
    expect(await alertExists('integrityAnomaly', review.id)).toBe(true);
  });

  it('a purged raw text cannot prove the title: TEXT_MISSING, no ledger', async () => {
    const { user, intent, message } = await scenario({ purgeable: true });
    // What the retention job does once purgeAfter has passed (the trigger allows only this).
    await t.db.bankMessageText.update({
      where: { bankMessageId: message.id },
      data: { text: null },
    });
    const review = await reviewOf(message.id);
    expect(review).toMatchObject({
      kind: 'UNRECOGNIZED',
      note: 'TEXT_MISSING',
      intentId: intent.id,
    });
    expect(await t.ledger(user.id)).toHaveLength(0);
    expect(await alertExists('unrecognized', review.id)).toBe(true);
  });

  it('the intent cancelled by the API while the matcher waits for the card lock is CANCELLED_LATE', async () => {
    const { user, intent, message } = await scenario({});
    t.a.hooks.afterCardLockFn = async () => {
      // Another session (the API's cancel) changes the intent before the matcher reads it.
      await t.db.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'CANCELLED', payTokenHash: null },
      });
    };
    const review = await reviewOf(message.id);
    expect(review).toMatchObject({ kind: 'CANCELLED_LATE', intentId: intent.id });
    expect(await t.ledger(user.id)).toHaveLength(0);
    expect(await t.db.payment.count({ where: { bankMessageId: message.id } })).toBe(0);
  });

  it('two cards paying one new user in parallel: the Wallet lock serialises the daily cap (one credit, one DAILY_LIMIT)', async () => {
    const user = await createUser(t.db);
    const base = 30_000_000n; // 300 000 so'm twice > the 500 000 so'm new-account cap
    const pay = async () => {
      const card = await createCard(t.db);
      const amountTiyin = base + (uniqueAmount() - BASE_TIYIN);
      await createIntent(t.db, user.id, card.id, {
        amountTiyin,
        baseAmountTiyin: base,
        status: 'EXPIRED',
        createdAt: new Date(Date.now() - 40 * MINUTE),
      });
      return insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: amountTiyin });
    };
    const [first, second] = [await pay(), await pay()];
    // A has credited (Wallet row locked) and, before committing, starts B on the other card
    // and waits until pg_locks shows B blocked on A's transaction (the Wallet row).
    let other: Promise<string> | undefined;
    t.a.hooks.beforeCommitFn = async (tx) => {
      other = t.b.matcher.process(second.id, false);
      await waitForBlockedSession(tx, 'myTransaction');
    };
    await expect(t.a.matcher.process(first.id, false)).resolves.toBe('PROCESSED');
    await expect(other).resolves.toBe('PROCESSED');
    expect((await t.outcome(first.id))?.outcome).toBe('CREDITED');
    expect((await t.outcome(second.id))?.review).toMatchObject({
      kind: 'DAILY_LIMIT',
      note: 'NEW_ACCOUNT_DAILY_LIMIT',
    });
    expect(await t.ledger(user.id)).toHaveLength(1);
  });
});
