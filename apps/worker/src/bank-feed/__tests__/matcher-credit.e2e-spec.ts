import { createPrismaClient } from '@repo/db';
import { topupCardLockKey, walletCacheKey } from '@repo/shared';
import { bootMatcher, TestHooks, useMatcherE2e } from './matcher-e2e.harness';
import {
  HOUR,
  createCard,
  createIntent,
  createUser,
  insertMessage,
  uniqueAmount,
} from './matcher-e2e.fixtures';
import { waitForBlockedSession } from './test-seams';

const t = useMatcherE2e();

/** A user, an ACTIVE card, a PENDING intent and the CREDIT message that pays it. */
async function paidScenario(opts: { status?: 'PENDING' | 'EXPIRED'; createdAt?: Date } = {}) {
  const user = await createUser(t.db);
  const card = await createCard(t.db);
  const amountTiyin = uniqueAmount();
  const intent = await createIntent(t.db, user.id, card.id, {
    amountTiyin,
    ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
  });
  const message = await insertMessage(t.db, { card, amountTiyin, balanceAfterTiyin: 90_000_000n });
  return { user, card, intent, message, amountTiyin };
}

describe('matcher: automatic credit (real Postgres + Redis)', () => {
  it('credits one PENDING intent: Payment + intent PAID + TOPUP + outcome, effects only after commit', async () => {
    const { user, intent, message, amountTiyin } = await paidScenario();
    await t.redis.client.set(walletCacheKey(user.id), '0');
    let seenInsideTx = false;
    t.a.hooks.beforeCommitFn = async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { bankMessageId: message.id } });
      // Before the commit: the cache is still there and nobody has been told anything.
      expect(await t.redis.client.exists(walletCacheKey(user.id))).toBe(1);
      expect(await t.notifyJob(`topup-${payment.id}`)).toBeUndefined();
      seenInsideTx = true;
    };
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    expect(seenInsideTx).toBe(true);

    const outcome = await t.outcome(message.id);
    expect(outcome).toMatchObject({ outcome: 'CREDITED', chainStatus: 'FIRST' });
    const payment = outcome?.payment;
    expect(payment).toMatchObject({
      provider: 'P2P_CARD',
      status: 'CONFIRMED',
      userId: user.id,
      intentId: intent.id,
      amountTiyin,
      providerTxnId: `${message.senderId.toString()}:${message.tgMessageId.toString()}`,
    });
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).toEqual(message.tgDate);
    const ledger = await t.ledger(user.id);
    expect(ledger.map((e) => [e.kind, e.amountTiyin, e.refType, e.refId])).toEqual([
      ['TOPUP', amountTiyin, 'PAYMENT', payment?.id],
    ]);
    expect(await t.redis.client.exists(walletCacheKey(user.id))).toBe(0);
    const job = await t.notifyJob(`topup-${payment?.id ?? ''}`);
    expect(job?.data).toEqual({ kind: 'TOPUP_CREDITED', refId: payment?.id });
  });

  it('the same message three times (job retry, re-enqueue, restarted worker) is ONE TOPUP', async () => {
    const { user, message } = await paidScenario();
    await t.a.matcher.process(message.id, false);
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('ALREADY_PROCESSED');
    const restarted = await bootMatcher(t.env, new TestHooks());
    try {
      await expect(restarted.matcher.process(message.id, true)).resolves.toBe('ALREADY_PROCESSED');
    } finally {
      await restarted.moduleRef.close();
    }
    expect(await t.ledger(user.id)).toHaveLength(1);
    expect(await t.db.payment.count({ where: { bankMessageId: message.id } })).toBe(1);
  });

  it('two workers on one message in parallel: ONE TOPUP, the second returns "already" without error', async () => {
    const { user, message } = await paidScenario();
    // Worker A, holding the card lock, starts B and keeps the lock until pg_locks shows B
    // waiting for it (no sleeping).
    let second: Promise<string> | undefined;
    let bLocked = false;
    t.a.hooks.afterCardLockFn = async (tx) => {
      second = t.b.matcher.process(message.id, false);
      await waitForBlockedSession(tx, 'advisory');
    };
    t.b.hooks.afterCardLockFn = () => {
      bLocked = true;
      return Promise.resolve();
    };
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    // B got the lock only after A committed, found A's outcome under it and wrote nothing.
    await expect(second).resolves.toBe('ALREADY_PROCESSED');
    expect(bLocked).toBe(true);
    expect(await t.ledger(user.id)).toHaveLength(1);
  });

  it('a failure in the middle of the transaction writes nothing; the retry then credits', async () => {
    const { user, intent, message } = await paidScenario();
    t.a.hooks.beforeCommitFn = () => Promise.reject(new Error('injected failure'));
    await expect(t.a.matcher.process(message.id, false)).rejects.toThrow('injected failure');
    expect(await t.outcome(message.id)).toBeNull();
    expect(await t.db.payment.count({ where: { bankMessageId: message.id } })).toBe(0);
    expect(await t.ledger(user.id)).toHaveLength(0);
    expect((await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      'PENDING',
    );
    t.a.hooks.reset();
    await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    expect(await t.ledger(user.id)).toHaveLength(1);
  });

  it('a late payment inside the grace (EXPIRED) is credited and announced as late', async () => {
    const { message, intent } = await paidScenario({
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    await t.a.matcher.process(message.id, false);
    const outcome = await t.outcome(message.id);
    expect(outcome?.outcome).toBe('CREDITED');
    const paid = await t.db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(paid.status).toBe('PAID');
    // The reservation never shrinks: GREATEST(old, paidAt + grace).
    expect(paid.reservedUntil?.getTime()).toBe(message.tgDate.getTime() + 24 * HOUR);
    const job = await t.notifyJob(`topup-${outcome?.paymentId ?? ''}`);
    expect(job?.data).toEqual({ kind: 'TOPUP_LATE_CREDITED', refId: outcome?.paymentId });
  });

  it('a payment after the grace is NO_MATCH, never credited', async () => {
    const { user, message } = await paidScenario({
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 30 * HOUR),
    });
    await t.a.matcher.process(message.id, false);
    expect((await t.outcome(message.id))?.review?.kind).toBe('NO_MATCH');
    expect(await t.ledger(user.id)).toHaveLength(0);
  });

  it('holds exactly ONE advisory lock, the API key hashtext(topup-card:<id>), never hashtextextended', async () => {
    const { card, message } = await paidScenario();
    const other = createPrismaClient(t.env.DATABASE_URL);
    const key = topupCardLockKey(card.id);
    try {
      t.a.hooks.afterCardLockFn = async (tx, cardId) => {
        expect(cardId).toBe(card.id);
        const mine = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`;
        expect(mine[0]?.n).toBe(1);
        // Another session (what the API's allocator does) cannot take the same key now...
        const same = await other.$transaction(
          (o) =>
            o.$queryRaw<
              { got: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS got`,
        );
        expect(same[0]?.got).toBe(false);
        // ...while a lock built with another hash function is a different lock.
        const different = await other.$transaction(
          (o) =>
            o.$queryRaw<
              { got: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS got`,
        );
        expect(different[0]?.got).toBe(true);
      };
      await expect(t.a.matcher.process(message.id, false)).resolves.toBe('PROCESSED');
    } finally {
      await other.$disconnect();
    }
  });
});
