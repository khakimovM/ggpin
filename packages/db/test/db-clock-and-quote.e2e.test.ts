import { describe, expect, it } from 'vitest';
import { createPrismaClient, resolveNeedsReview, ReviewProofError } from '../src/index';
import { readDatabaseNow } from '../src/orders/payout-state';
import { requireTestDatabaseUrl } from './db-guard';
import { db } from './client';
import { expectGuard } from './check-helpers';
import { createQuote, createUser } from './factories';
import {
  OPERATOR,
  RECONCILER,
  addAttempt,
  captureError,
  manualProof,
  notSentProof,
  paidOrder,
  reviewOrder,
  statusOf,
  uniqueHash,
} from './order-fixtures';

// Audit L1 (the clock under a non-UTC session), L8 (a backdated createdAt), Y5 (a quote used after it
// expired by the wall clock) and Y6 (an order for another recipient than its quote's); review P4.
// D-59 B5, B6, B10, B11.

const TASHKENT = `SET LOCAL timezone = 'Asia/Tashkent'`;

describe('L1: the clock of the helpers does not depend on the session TimeZone', () => {
  it('every session of createPrismaClient speaks UTC (a startup parameter, not a server default)', async () => {
    const client = createPrismaClient(requireTestDatabaseUrl(process.env['DATABASE_URL']));
    try {
      const rows = await client.$queryRaw<
        { tz: string }[]
      >`SELECT current_setting('TimeZone') AS "tz"`;
      expect(rows[0]?.tz).toBe('UTC');
    } finally {
      await client.$disconnect();
    }
  });

  it('readDatabaseNow is within seconds of the real time in a UTC session and in an Asia/Tashkent one', async () => {
    await db.$transaction(async (tx) => {
      expect(Math.abs((await readDatabaseNow(tx)).getTime() - Date.now())).toBeLessThan(10_000);
      await tx.$executeRawUnsafe(TASHKENT);
      // Five hours of drift (the old behaviour) would show up as 18 000 000 ms.
      expect(Math.abs((await readDatabaseNow(tx)).getTime() - Date.now())).toBeLessThan(10_000);
    });
  });

  it('the age rule still holds in an Asia/Tashkent session: a fresh transfer-less SENDING attempt is not "never sent"', async () => {
    const { order } = await paidOrder('PROCESSING');
    await addAttempt(order.id, 'SENDING');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    const error = await captureError(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(TASHKENT);
        return resolveNeedsReview(tx, {
          orderId: order.id,
          to: 'FAILED',
          proof: manualProof,
          resolver: OPERATOR,
        });
      }),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('LIVE_PAYOUT');
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });

  it('checkedAt an hour in the future is refused in an Asia/Tashkent session: no skew is allowed', async () => {
    const review = await reviewOrder('EXPIRED');
    const proof = notSentProof(review.transfer, {
      checkedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const error = await captureError(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(TASHKENT);
        return resolveNeedsReview(tx, {
          orderId: review.order.id,
          to: 'FAILED',
          proof,
          resolver: RECONCILER,
        });
      }),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('MISMATCH');
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
  });

  it('the SQL guard of a transfer judges UTC too: EXPIRED before validUntil + margin is refused in any session', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await db.tonTransfer.create({
      data: {
        purpose: 'ORDER',
        attemptId: attempt.id,
        network: 'mainnet',
        walletAddress: `0:${uniqueHash()}`,
        seqno: 5,
        validUntil: new Date(Date.now() + 45_000),
        toAddress: `0:${'c'.repeat(64)}`,
        amountNanoTon: 1_000_000n,
        payloadHash: 'd'.repeat(64),
        extMsgHash: uniqueHash(),
        bocBase64: 'te6cc',
        status: 'SIGNED',
      },
    });
    await expectGuard(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(TASHKENT);
        await tx.tonTransfer.update({ where: { id: transfer.id }, data: { status: 'EXPIRED' } });
      }),
      'cannot expire before validUntil',
    );
  });
});

describe('L8: createdAt of an attempt and of a transfer is the database clock', () => {
  it('an attempt inserted with createdAt an hour back is stamped now, and the age rule still applies (BACKDATE)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await db.fulfillmentAttempt.create({
      data: {
        orderId: order.id,
        attemptNo: 1,
        adapter: 'FRAGMENT',
        status: 'SENDING',
        request: {},
        createdAt: new Date(Date.now() - 3_600_000),
      },
    });
    expect(Math.abs(attempt.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    await db.order.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    const error = await captureError(
      db.$transaction((tx) =>
        resolveNeedsReview(tx, {
          orderId: order.id,
          to: 'FAILED',
          proof: manualProof,
          resolver: OPERATOR,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('LIVE_PAYOUT');
  });

  it('a transfer inserted with createdAt a day back is stamped now too', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await db.tonTransfer.create({
      data: {
        purpose: 'ORDER',
        attemptId: attempt.id,
        network: 'mainnet',
        walletAddress: `0:${uniqueHash()}`,
        seqno: 6,
        validUntil: new Date(Date.now() + 60_000),
        toAddress: `0:${'c'.repeat(64)}`,
        amountNanoTon: 1_000_000n,
        payloadHash: 'd'.repeat(64),
        extMsgHash: uniqueHash(),
        bocBase64: 'te6cc',
        status: 'SIGNED',
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });
    expect(Math.abs(transfer.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

describe('Y5 (P4): a quote cannot be used after it expired, judged at the moment of the write', () => {
  // Review N8: only the DATABASE clock is used. The expiry is set inside the transaction to its own
  // start + 1 s (now()), so "began before the expiry" holds by construction, whatever the load or
  // the skew between Node and Postgres; the use comes after pg_sleep(1.5), past the expiry on the
  // statement clock the guard reads. The generous timeout keeps a slow machine from turning this
  // into a transaction-timeout failure (it once ran 5077 ms against Prisma's default 5 s).
  it('a transaction that began before the expiry cannot use the quote after it', async () => {
    const user = await createUser();
    const quote = await createQuote(user.id);
    await expectGuard(
      db.$transaction(
        async (tx) => {
          // The expiry is immutable (Quote_immutable_guard): it is moved with the triggers off for
          // this one statement, then they are back on for the use the test is about.
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
          await tx.$executeRaw`
            UPDATE "Quote" SET "expiresAt" = timezone('UTC', now()) + interval '1 second'
            WHERE "id" = ${quote.id}`;
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
          const [began] = await tx.$queryRaw<{ before: boolean }[]>`
            SELECT timezone('UTC', now()) < "expiresAt" AS before FROM "Quote"
            WHERE "id" = ${quote.id}`;
          expect(began?.before).toBe(true);
          await tx.$executeRaw`SELECT pg_sleep(1.5)`;
          await tx.$executeRaw`
            UPDATE "Quote" SET "usedAt" = timezone('UTC', clock_timestamp())
            WHERE "id" = ${quote.id}`;
        },
        { timeout: 30_000 },
      ),
      'expired quote',
    );
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).toBeNull();
  });

  it('a live quote is used as before, even late in a long transaction', async () => {
    const user = await createUser();
    const quote = await createQuote(user.id);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.5)`;
      await tx.quote.update({ where: { id: quote.id }, data: { usedAt: new Date() } });
    });
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).not.toBeNull();
  });
});
