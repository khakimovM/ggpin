import { describe, expect, it } from 'vitest';
import {
  OrderNotFoundError,
  ReviewProofError,
  StaleOrderStateError,
  sumBalance,
} from '../src/index';
import { resolveNeedsReviewAt } from '../src/orders/needs-review-resolve';
import { db } from './client';
import {
  NOW,
  OPERATOR,
  PRICE,
  RECONCILER,
  adminResolver,
  captureError,
  createAdmin,
  events,
  manualProof,
  notSentProof,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
  tonTxProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// resolveNeedsReview: the only way out of NEEDS_REVIEW, bound to the order's own rows. The
// mismatch matrix (a proof that does not fit the order) is in needs-review-binding.e2e.test.ts.

const audit = (orderId: string) => db.auditLog.findMany({ where: { targetId: orderId } });
const attemptStatus = async (id: string) =>
  (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id } })).status;

describe('a proof that fits the order leaves NEEDS_REVIEW', () => {
  it('TON_TX delivers: the attempt is confirmed, deliveredAt is set, nothing is refunded', async () => {
    const { user, order, attempt, transfer } = await reviewOrder('CONFIRMED');
    const proof = tonTxProof(transfer);
    const result = await resolve({
      orderId: order.id,
      to: 'DELIVERED',
      proof,
      resolver: RECONCILER,
    });
    expect(result).toEqual({
      to: 'DELIVERED',
      userId: user.id,
      refund: null,
      closedAttemptIds: [attempt.id],
      securityAlert: null,
    });
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.statusReason).toBeNull();
    expect(await attemptStatus(attempt.id)).toBe('CONFIRMED');
    expect(await refunds(order.id)).toHaveLength(0);
    expect(await sumBalance(db, user.id)).toBe(-PRICE);
    expect(await events(order.id)).toMatchObject([
      { from: 'NEEDS_REVIEW', to: 'DELIVERED', actor: 'RECONCILER' },
    ]);
  });

  it('the audit row carries the proof, the resolver and the outcome (reconciler)', async () => {
    const { order, transfer } = await reviewOrder('CONFIRMED');
    const proof = tonTxProof(transfer);
    await resolve({ orderId: order.id, to: 'DELIVERED', proof, resolver: RECONCILER });
    const rows = await audit(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      reason: proof.reason,
      ip: null,
      before: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
      after: {
        proof,
        resolver: 'reconciler',
        operator: null,
        osUser: null,
        otpVerified: null,
        refund: null,
      },
    });
  });

  it('TON_NOT_SENT fails and refunds: the attempt fails, the reason survives the refund', async () => {
    const { user, order, attempt, transfer } = await reviewOrder('EXPIRED');
    const result = await resolve({
      orderId: order.id,
      to: 'FAILED',
      proof: notSentProof(transfer),
      resolver: RECONCILER,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await attemptStatus(attempt.id)).toBe('FAILED');
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('REFUNDED');
    expect(row.statusReason).toBe('CONFIRM_TIMEOUT');
    expect(await sumBalance(db, user.id)).toBe(0n);
    expect(await refunds(order.id)).toHaveLength(1);
    expect((await events(order.id)).map((e) => `${e.from}>${e.to}:${e.actor}`)).toEqual([
      'NEEDS_REVIEW>FAILED:RECONCILER',
      'FAILED>REFUNDED:SYSTEM',
    ]);
    const [row0] = await audit(order.id);
    expect(row0?.after).toMatchObject({
      refund: { amountTiyin: PRICE.toString(), ledgerEntryId: expect.any(String) as unknown },
    });
  });

  it('refunds price minus discount', async () => {
    const { user, order, transfer } = await reviewOrder('EXPIRED', 'UNKNOWN', 1_200_000n);
    const result = await resolve({
      orderId: order.id,
      to: 'FAILED',
      proof: notSentProof(transfer),
      resolver: RECONCILER,
    });
    expect(result.refund).toMatchObject({ amountTiyin: PRICE - 1_200_000n });
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('FRAGMENT_STATUS delivers (an operator carries it: the reconciler never does) when its request is the attempt reference', async () => {
    const { order, attempt } = await reviewOrder('CONFIRMED');
    const proof = {
      kind: 'FRAGMENT_STATUS',
      requestRef: attempt.externalRef,
      status: 'DONE',
      observedAt: NOW.toISOString(),
      reason: 'Fragment shows the order as completed',
    };
    await resolve({ orderId: order.id, to: 'DELIVERED', proof, resolver: OPERATOR });
    expect(await statusOf(order.id)).toBe('DELIVERED');
    expect(await attemptStatus(attempt.id)).toBe('CONFIRMED');
  });

  it('an operator resolves with MANUAL evidence either way, recorded as the operator', async () => {
    const delivered = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: delivered.order.id,
      to: 'DELIVERED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    const failed = await reviewOrder('EXPIRED');
    // An ADMIN is judged by the database: an active OWNER, with the OTP (audit L3, L4).
    const admin = await createAdmin('OWNER');
    await resolve({
      orderId: failed.order.id,
      to: 'FAILED',
      proof: manualProof,
      resolver: adminResolver(admin.id),
    });
    expect(await statusOf(delivered.order.id)).toBe('DELIVERED');
    expect(await statusOf(failed.order.id)).toBe('REFUNDED');
    const [cli] = await audit(delivered.order.id);
    expect(cli).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      ip: '10.0.0.1',
      after: {
        resolver: 'operator',
        operator: { type: 'CLI', id: 'owner-1' },
        osUser: 'aziz',
        otpVerified: true,
      },
    });
    const [adm] = await audit(failed.order.id);
    expect(adm).toMatchObject({
      actorType: 'ADMIN',
      actorId: admin.id,
      ip: '10.0.0.2',
      after: { operator: { type: 'ADMIN', id: admin.id, role: 'OWNER' }, otpVerified: true },
    });
    expect((await events(failed.order.id)).map((e) => e.actor)).toEqual([
      `ADMIN:${admin.id}`,
      `ADMIN:${admin.id}`,
    ]);
  });
});

describe('only NEEDS_REVIEW can be resolved, once', () => {
  it('any other status is stale and writes no audit row', async () => {
    for (const status of ['PROCESSING', 'HELD', 'DELIVERED', 'FAILED'] as const) {
      const { order } = await paidOrder(status);
      const error = await captureError(
        resolve({ orderId: order.id, to: 'DELIVERED', proof: manualProof, resolver: OPERATOR }),
      );
      expect(error, status).toBeInstanceOf(StaleOrderStateError);
      expect(await audit(order.id)).toHaveLength(0);
    }
    expect(
      await captureError(
        resolve({ orderId: 'ghost', to: 'DELIVERED', proof: manualProof, resolver: OPERATOR }),
      ),
    ).toBeInstanceOf(OrderNotFoundError);
  });

  it('two resolvers at once: one wins, the other changes nothing, one refund, one audit row', async () => {
    const { user, order, transfer } = await reviewOrder('EXPIRED');
    const proof = notSentProof(transfer);
    const results = await Promise.allSettled([
      resolve({ orderId: order.id, to: 'FAILED', proof, resolver: RECONCILER }),
      resolve({ orderId: order.id, to: 'FAILED', proof, resolver: RECONCILER }),
      resolve({ orderId: order.id, to: 'FAILED', proof: manualProof, resolver: OPERATOR }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StaleOrderStateError);
    }
    expect(await audit(order.id)).toHaveLength(1);
    expect(await refunds(order.id)).toHaveLength(1);
    expect(await sumBalance(db, user.id)).toBe(0n);
  });

  it('the attempt, the transition, the refund and the audit row are one unit', async () => {
    const { user, order, attempt, transfer } = await reviewOrder('EXPIRED');
    await captureError(
      db.$transaction(async (tx) => {
        await resolveNeedsReviewAt(
          tx,
          { orderId: order.id, to: 'FAILED', proof: notSentProof(transfer), resolver: RECONCILER },
          NOW,
        );
        throw new Error('boom');
      }),
    );
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
    expect(await attemptStatus(attempt.id)).toBe('UNKNOWN');
    expect(await refunds(order.id)).toHaveLength(0);
    expect(await audit(order.id)).toHaveLength(0);
    expect(await sumBalance(db, user.id)).toBe(-PRICE);
  });
});

describe('the resolver is a trusted parameter, not part of the proof', () => {
  it('P3: a proof that names an actor is refused: nobody can sign as the reconciler', async () => {
    const { order, transfer } = await reviewOrder('EXPIRED');
    for (const actor of ['reconciler', 'admin', 'system']) {
      const error = await captureError(
        resolve({
          orderId: order.id,
          to: 'FAILED',
          proof: notSentProof(transfer, { actor }),
          resolver: OPERATOR,
        }),
      );
      expect((error as ReviewProofError).problem, actor).toBe('INVALID');
    }
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });

  it('P6: an operator without an id is refused (the audit row must name them)', async () => {
    const { order } = await reviewOrder('EXPIRED');
    for (const id of ['', '   ']) {
      const error = await captureError(
        resolve({
          orderId: order.id,
          to: 'FAILED',
          proof: manualProof,
          resolver: { ...OPERATOR, id },
        }),
      );
      expect((error as ReviewProofError).problem).toBe('OPERATOR_REQUIRED');
    }
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });

  it('MANUAL evidence is an operator only: the reconciler cannot carry it', async () => {
    const { order } = await reviewOrder('EXPIRED');
    const error = await captureError(
      resolve({ orderId: order.id, to: 'FAILED', proof: manualProof, resolver: RECONCILER }),
    );
    expect((error as ReviewProofError).problem).toBe('ACTOR_MISMATCH');
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });
});
