import type { QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import { failAndRefundOrder, type Tx } from '../src/index';
import { resolveNeedsReviewAt } from '../src/orders/needs-review-resolve';
import { db } from './client';
import {
  TEST_MS,
  connect,
  heldTransaction,
  hex,
  pidOf,
  waitUntilAnyBlocked,
  waitUntilBlocked,
} from './race-utils';
import { expectGuard } from './check-helpers';
import {
  OPERATOR,
  addAttempt,
  captureError,
  forceAttempt,
  forceTransfer,
  manualProof,
  paidOrder,
  refunds,
  statusOf,
} from './order-fixtures';

// Audit RA1, RA2, RA4 (D-59 B15): the races of the payout path at the level of the HELPERS, not only
// of the raw SQL (payout-race.e2e.test.ts): a worker's INSERT against `failAndRefundOrder`, and a
// stalled worker's `externalRef` write against `resolveNeedsReview`. The helper side holds a Prisma
// transaction open; the worker side is a separate pg connection. Every wait has a timeout.

const insertAttempt = (orderId: string): QueryConfig => ({
  text: `INSERT INTO "FulfillmentAttempt" ("id", "orderId", "attemptNo", "adapter", "status", "request", "updatedAt")
    VALUES ('race-h-attempt-' || $1::text, $1::text, 1, 'FRAGMENT', 'SENDING', '{}', now())`,
  values: [orderId],
});

const insertTransfer = (attemptId: string): QueryConfig => ({
  text: `INSERT INTO "TonTransfer" ("id", "purpose", "attemptId", "network", "walletAddress", "seqno", "validUntil",
      "toAddress", "amountNanoTon", "payloadHash", "extMsgHash", "bocBase64", "status", "updatedAt")
    VALUES ('race-h-transfer-' || $1::text, 'ORDER', $1::text, 'mainnet', '0:' || $2::text, 41,
      now() + interval '1 minute', '0:' || repeat('c', 64), 235000000, repeat('d', 64), $3::text,
      'te6cc', 'SIGNED', now())`,
  values: [attemptId, hex(), hex()],
});

const failHelper = (tx: Tx, orderId: string) =>
  failAndRefundOrder(tx, {
    orderId,
    from: 'PROCESSING',
    reason: 'RECIPIENT_GONE',
    actor: 'system',
  });

describe("RA1: the helper fails and refunds first, the worker's attempt INSERT waits and is refused", () => {
  it(
    'the INSERT blocks on the order row, then GG001 "can only be created for an order that is PROCESSING"',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const worker = await connect();
      try {
        await worker.query('BEGIN');
        const workerPid = await pidOf(worker);
        const helper = heldTransaction((tx) => failHelper(tx, order.id));
        await helper.ready;
        const pending = worker.query(insertAttempt(order.id)).then(
          () => 'INSERTED',
          (error: unknown) => error,
        );
        await waitUntilBlocked(workerPid);
        helper.release();
        expect((await helper.done).ok).toBe(true);
        const outcome = await pending;
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as { code?: unknown }).code).toBe('GG001');
        expect((outcome as Error).message).toContain('PROCESSING');
      } finally {
        await worker.query('ROLLBACK').catch(() => undefined);
        await worker.end();
      }
      expect(await statusOf(order.id)).toBe('REFUNDED');
      expect(await db.fulfillmentAttempt.count({ where: { orderId: order.id } })).toBe(0);
      expect(await refunds(order.id)).toHaveLength(1);
    },
    TEST_MS,
  );
});

describe("RA2: the worker's attempt INSERT first, the helper waits and then refuses (LivePayoutError)", () => {
  it(
    'nothing is failed or refunded: the committed SENDING attempt stops it',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const worker = await connect();
      try {
        await worker.query('BEGIN');
        const workerPid = await pidOf(worker);
        await worker.query(insertAttempt(order.id));
        const helper = db.$transaction((tx) => failHelper(tx, order.id), {
          timeout: 60_000,
          maxWait: 30_000,
        });
        const settled = captureError(helper);
        await waitUntilAnyBlocked(workerPid);
        await worker.query('COMMIT');
        const error = await settled;
        expect(error).toMatchObject({ name: 'LivePayoutError', detail: 'attempt is SENDING' });
      } finally {
        await worker.query('ROLLBACK').catch(() => undefined);
        await worker.end();
      }
      expect(await statusOf(order.id)).toBe('PROCESSING');
      expect(await refunds(order.id)).toHaveLength(0);
      expect(await db.fulfillmentAttempt.count({ where: { orderId: order.id } })).toBe(1);
    },
    TEST_MS,
  );
});

describe('RA4: a stalled worker against resolveNeedsReview (transfer-less SENDING attempt)', () => {
  it(
    'its externalRef write waits for the operator, is then refused (plain) or writes nothing (CAS), and it cannot sign',
    async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING', { externalRef: null });
      await db.order.update({
        where: { id: order.id },
        data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
      });
      // The injected clock is six minutes after the attempt: past lockDuration + margin.
      const clock = new Date(attempt.createdAt.getTime() + 6 * 60_000);
      const worker = await connect();
      try {
        const workerPid = await pidOf(worker);
        const operator = heldTransaction((tx) =>
          resolveNeedsReviewAt(
            tx,
            { orderId: order.id, to: 'FAILED', proof: manualProof, resolver: OPERATOR },
            clock,
          ),
        );
        await operator.ready;
        const plain = worker
          .query(`UPDATE "FulfillmentAttempt" SET "externalRef" = $2 WHERE "id" = $1`, [
            attempt.id,
            hex(),
          ])
          .then(
            () => 'WRITTEN',
            (error: unknown) => error,
          );
        await waitUntilBlocked(workerPid);
        operator.release();
        expect((await operator.done).ok).toBe(true);
        const refusedPlain = await plain;
        expect(refusedPlain).toBeInstanceOf(Error);
        expect((refusedPlain as { code?: unknown }).code).toBe('GG001');
        expect((refusedPlain as Error).message).toContain('externalRef cannot be written');
        // The compare-and-set the worker really uses touches no row once the attempt is FAILED.
        const cas = await worker.query(
          `UPDATE "FulfillmentAttempt" SET "externalRef" = $2
           WHERE "id" = $1 AND "externalRef" IS NULL AND "status" IN ('SENDING', 'SENT', 'UNKNOWN')`,
          [attempt.id, hex()],
        );
        expect(cas.rowCount).toBe(0);
        const signed = await worker.query(insertTransfer(attempt.id)).then(
          () => 'SIGNED',
          (error: unknown) => error,
        );
        expect((signed as { code?: unknown }).code).toBe('GG001');
        expect((signed as Error).message).toContain('PROCESSING');
      } finally {
        await worker.end();
      }
      expect(await statusOf(order.id)).toBe('REFUNDED');
      const row = await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row).toMatchObject({ status: 'FAILED', externalRef: null });
      expect(await db.tonTransfer.count()).toBe(0);
    },
    TEST_MS,
  );
});

describe('I5: the transfer alone stops the order, with no attempt in flight (audit I5)', () => {
  // The race of the older tests (payout-race.e2e.test.ts, "(b) the transfer is signed first") has a
  // SENDING attempt as well, so it cannot say how much the transfer contributes. A legal state with a
  // transfer that is not EXPIRED and an attempt that is not alive cannot exist (the attempt guard
  // refuses it), so it is forced in: it is what a corrupt row would look like.
  it.each([
    'SIGNED',
    'BROADCAST',
    'CONFIRMED',
    'ONCHAIN_FAILED',
    'BOUNCED',
    'CONSUMED_UNMATCHED',
  ] as const)(
    'a %s transfer of a FAILED attempt refuses PROCESSING -> FAILED on its own',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await forceAttempt(order.id, 'FAILED');
      await forceTransfer(attempt.id, status);
      await expectGuard(
        db.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', statusReason: 'RECIPIENT_GONE' },
        }),
        'may have gone out',
      );
      expect(await statusOf(order.id)).toBe('PROCESSING');
    },
  );

  it('an EXPIRED transfer of a FAILED attempt does not: it is the one state that is "not sent"', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await forceAttempt(order.id, 'FAILED');
    await forceTransfer(attempt.id, 'EXPIRED');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'FAILED', statusReason: 'RECIPIENT_GONE' },
    });
    expect(await statusOf(order.id)).toBe('FAILED');
  });
});
