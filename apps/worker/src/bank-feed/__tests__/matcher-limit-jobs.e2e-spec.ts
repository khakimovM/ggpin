import { createPrismaClient, type PrismaClient, type TopupCard } from '@repo/db';
import { cardLimitAlertRef, topupCardLockKey } from '@repo/shared';
import { BankFeedEffects } from '../bank-feed-effects';
import { BankFeedNotifier } from '../bank-feed-notifier';
import { BankMessageRepository } from '../bank-message.repository';
import { FailClosedService } from '../fail-closed.service';
import { MatchWritesRepository } from '../match-writes.repository';
import { TopupCardsRepository } from '../topup-cards.repository';
import { TEST_FAIL_CLOSED_TIMING, useMatcherE2e } from './matcher-e2e.harness';
import { createCard, insertMessage, uniqueAmount } from './matcher-e2e.fixtures';
import { fakeJob } from './test-seams';

const t = useMatcherE2e();

async function alertExists(alert: string, refId: string): Promise<boolean> {
  return (await t.notifyJob(`alert-${alert}-${refId}`)) !== undefined;
}

function fullRef(card: TopupCard): string {
  return cardLimitAlertRef('cardFull', {
    cardId: card.id,
    receiveLimitTiyin: card.receiveLimitTiyin,
    monthlyLimitTiyin: card.monthlyLimitTiyin,
  });
}

/** True when some session waits for an advisory lock in this database. */
async function advisoryWaiter(db: PrismaClient): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return (rows[0]?.n ?? 0) > 0;
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Holds the card's advisory lock in another session (what a busy API allocation does) while
 * `body` runs, then releases it. Returns body's result.
 */
async function withCardHeld<T>(card: TopupCard, body: (db: PrismaClient) => Promise<T>) {
  const other = createPrismaClient(t.env.DATABASE_URL);
  try {
    return await other.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${topupCardLockKey(card.id)}))`;
        return body(other);
      },
      { timeout: 30_000 },
    );
  } finally {
    await other.$disconnect();
  }
}

/** Finds Postgres' lock-timeout code anywhere in the error (Prisma wraps the driver error). */
function isLockTimeout(error: unknown): boolean {
  return JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})).includes('55P03');
}

/** An unmatched CREDIT on `card` that alone fills it (~50 000 so'm on a 50 000 so'm limit). */
async function fillingMessage(card: TopupCard) {
  return insertMessage(t.db, { card, amountTiyin: uniqueAmount(), balanceAfterTiyin: 9n });
}

describe('card-limit job, fail-closed retries and the busy card (M-1, m-2, N6)', () => {
  it('M-1: the review alert goes out first; a busy card only delays the limit check, which runs later', async () => {
    const card = await createCard(t.db, { limitTiyin: 5_000_000n });
    const message = await fillingMessage(card);
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    const review = (await t.outcome(message.id))?.review;
    expect(review?.kind).toBe('NO_MATCH');
    // The decision's alert is queued without the card lock; the limit check is its own job.
    expect(await alertExists('noMatch', review?.id ?? '')).toBe(true);
    expect((await t.limitJob(message.id))?.data).toEqual({ bankMessageId: message.id });

    const busy = await withCardHeld(card, async () =>
      t.a.limitProcessor
        .process(fakeJob({ bankMessageId: message.id }, 0, 8))
        .then(() => null)
        .catch((error: unknown) => error),
    );
    expect(isLockTimeout(busy)).toBe(true);
    expect((await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'ACTIVE',
    );
    // The retry (the queue's backoff) completes the check.
    await expect(t.checkLimits(message.id)).resolves.toBe('CHECKED');
    const after = await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('FULL');
    expect(await alertExists('cardFull', fullRef(after))).toBe(true);
  }, 30_000);

  it('M-1: after the LAST attempt of the limit check fails, the owner gets limitCheckFailed', async () => {
    const card = await createCard(t.db, { limitTiyin: 5_000_000n });
    const message = await fillingMessage(card);
    await t.a.matcher.process(message.id, false);
    const last = await withCardHeld(card, async () =>
      t.a.limitProcessor
        .process(fakeJob({ bankMessageId: message.id }, 7, 8))
        .then(() => null)
        .catch((error: unknown) => error),
    );
    expect(isLockTimeout(last)).toBe(true);
    const job = await t.notifyJob(`alert-limitCheckFailed-${message.id}`);
    expect(job?.data).toEqual({
      kind: 'OWNER_ALERT',
      alert: 'limitCheckFailed',
      refId: message.id,
    });
  }, 30_000);

  it('M-1 on the fail-closed path: its alert and its limit job are queued, the check runs later', async () => {
    const card = await createCard(t.db, { limitTiyin: 5_000_000n });
    const message = await fillingMessage(card);
    t.a.hooks.beforeCommitFn = () => Promise.reject(new Error('injected failure'));
    await expect(t.a.processor.process(fakeJob({ bankMessageId: message.id }, 4))).resolves.toBe(
      'FAILED_CLOSED',
    );
    const review = (await t.outcome(message.id))?.review;
    expect(review).toMatchObject({ kind: 'UNRECOGNIZED', note: 'PROCESSING_FAILED' });
    expect(await alertExists('processingFailed', review?.id ?? '')).toBe(true);
    const busy = await withCardHeld(card, async () =>
      t.a.limitProcessor
        .process(fakeJob({ bankMessageId: message.id }, 0, 8))
        .then(() => null)
        .catch((error: unknown) => error),
    );
    expect(isLockTimeout(busy)).toBe(true);
    await expect(t.checkLimits(message.id)).resolves.toBe('CHECKED');
    expect((await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'FULL',
    );
  }, 30_000);

  it('m-2: fail-closed tries again after a lock timeout and then writes the review', async () => {
    const card = await createCard(t.db);
    const message = await fillingMessage(card);
    // The suites' timing with a long pause, so the lock is surely released between the tries.
    const get = <T>(type: new (...args: never[]) => T): T => t.a.moduleRef.get(type);
    const failClosed = new FailClosedService(
      get(BankMessageRepository),
      get(MatchWritesRepository),
      get(TopupCardsRepository),
      get(BankFeedEffects),
      get(BankFeedNotifier),
      { ...TEST_FAIL_CLOSED_TIMING, pauseMs: 2_000 },
    );
    let closing: Promise<string> = Promise.resolve('not started');
    await withCardHeld(card, async (other) => {
      closing = failClosed.close(message.id);
      // The first try waits for the card lock and gives up after lockWaitMs...
      await until(() => advisoryWaiter(other));
      await until(async () => !(await advisoryWaiter(other)));
      // ...then this callback returns, the lock is released during the pause.
    });
    await expect(closing).resolves.toBe('FAILED_CLOSED');
    expect((await t.outcome(message.id))?.review).toMatchObject({ note: 'PROCESSING_FAILED' });
    expect(
      (await t.db.topupCard.findUniqueOrThrow({ where: { id: card.id } })).autoCreditPaused,
    ).toBe(true);
  }, 30_000);

  it('m-2: when no try can write the review, the owner gets messageStuck and the job stays failed', async () => {
    const card = await createCard(t.db);
    const message = await fillingMessage(card);
    t.a.hooks.beforeCommitFn = () => Promise.reject(new Error('injected failure'));
    const failure = await withCardHeld(card, async () =>
      t.a.processor
        .process(fakeJob({ bankMessageId: message.id }, 4))
        .then(() => null)
        .catch((error: unknown) => error),
    );
    // The original error stays the job's failure; nothing was written.
    expect(isLockTimeout(failure)).toBe(true);
    expect(await t.outcome(message.id)).toBeNull();
    const job = await t.notifyJob(`alert-messageStuck-${message.id}`);
    expect(job?.data).toEqual({ kind: 'OWNER_ALERT', alert: 'messageStuck', refId: message.id });
  }, 30_000);

  it('N6: a card held elsewhere fails the attempt with 55P03 after lock_timeout; the retry processes it', async () => {
    const card = await createCard(t.db);
    const message = await fillingMessage(card);
    const timing = await withCardHeld(card, async (other) => {
      const [start] = await other.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      const attempt = t.a.processor
        .process(fakeJob({ bankMessageId: message.id }, 0))
        .then(() => null)
        .catch((error: unknown) => error);
      await until(() => advisoryWaiter(other));
      const error = await attempt;
      const [end] = await other.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      return { error, ms: (end?.at.getTime() ?? 0) - (start?.at.getTime() ?? 0) };
    });
    expect(isLockTimeout(timing.error)).toBe(true);
    // Measured by Postgres itself: it waited the configured lock_timeout, not much longer.
    expect(timing.ms).toBeGreaterThanOrEqual(t.env.BANK_FEED_LOCK_TIMEOUT_MS);
    expect(timing.ms).toBeLessThan(t.env.BANK_FEED_LOCK_TIMEOUT_MS + 2_000);
    expect(await t.outcome(message.id)).toBeNull();
    await expect(t.a.processor.process(fakeJob({ bankMessageId: message.id }, 1))).resolves.toBe(
      'PROCESSED',
    );
  }, 30_000);
});
