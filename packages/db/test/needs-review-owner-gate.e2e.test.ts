import { describe, expect, it } from 'vitest';
import { sumBalance } from '../src/index';
import { db } from './client';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  RECONCILER,
  adminResolver,
  createAdmin,
  manualProof,
  notSentProof,
  reviewOrder,
  statusOf,
  tonTxProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Audit L2, L3, L4, Y4, review Y12, P3, P6, Q4b (D-59 B2-B4, B9): who may resolve a NEEDS_REVIEW
// order. The role is the DATABASE's (an ADMIN is re-read inside the transaction), the OTP flag is
// the boolean `true`, a MANUAL decision (either exit) is an OWNER + OTP action, and the reconciler
// carries only the proofs the chain itself backs.

const FRAGMENT_DONE = (requestRef: string | null) => ({
  kind: 'FRAGMENT_STATUS',
  requestRef,
  status: 'DONE',
  observedAt: '2026-11-11T10:06:00.000Z',
  reason: 'Fragment shows the order as completed',
});

describe('L3: the role is read from the database, never taken from the caller', () => {
  it('an ADMIN that is not in AdminUser is refused (OWNER_REQUIRED), nothing is written', async () => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      adminResolver('no-such-admin'),
      'OWNER_REQUIRED',
      'ghost',
    );
  });

  it.each(['OPERATOR', 'SUPPORT'] as const)(
    'an ADMIN with the %s role is refused, whatever the caller writes',
    async (role) => {
      const admin = await createAdmin(role);
      const review = await reviewOrder('CONFIRMED');
      for (const claimed of [undefined, 'OWNER']) {
        await expectRefused(
          review,
          'DELIVERED',
          manualProof,
          adminResolver(admin.id, claimed === undefined ? {} : { role: claimed }),
          'OWNER_REQUIRED',
          `${role} claims ${String(claimed)}`,
        );
      }
    },
  );

  it('a deactivated OWNER is refused', async () => {
    const admin = await createAdmin('OWNER', false);
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      adminResolver(admin.id),
      'OWNER_REQUIRED',
      'inactive',
    );
  });

  it('an active OWNER resolves, and the audit row carries the role the database has', async () => {
    const admin = await createAdmin('OWNER');
    const review = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: review.order.id,
      to: 'DELIVERED',
      proof: manualProof,
      resolver: adminResolver(admin.id),
    });
    expect(await statusOf(review.order.id)).toBe('DELIVERED');
    const [audit] = await db.auditLog.findMany({ where: { targetId: review.order.id } });
    expect(audit).toMatchObject({
      actorType: 'ADMIN',
      actorId: admin.id,
      after: { operator: { type: 'ADMIN', id: admin.id, role: 'OWNER' }, otpVerified: true },
    });
  });

  it('a CLI operator is the owner: no AdminUser row is needed', async () => {
    const review = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: review.order.id,
      to: 'DELIVERED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(await statusOf(review.order.id)).toBe('DELIVERED');
  });
});

describe('L2: every field of the resolver is checked with typeof', () => {
  it.each([
    ['the string "yes"', 'yes'],
    ['the number 1', 1],
    ['a missing flag', undefined],
    ['null', null],
    ['the string "true"', 'true'],
  ])('otpVerified as %s does not count', async (_label, otpVerified) => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      { ...OPERATOR, otpVerified },
      'OPERATOR_REQUIRED',
      String(otpVerified),
    );
  });

  it('a false flag on a proof that needs the OTP is OWNER_REQUIRED', async () => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      { ...OPERATOR, otpVerified: false },
      'OWNER_REQUIRED',
      'false',
    );
  });

  it.each([
    ['a null resolver', null],
    ['a string', 'owner'],
    ['an unknown kind', { kind: 'system' }],
    ['an unknown type', { ...OPERATOR, type: 'WEB' }],
    ['a numeric id', { ...OPERATOR, id: 7 }],
    ['a blank id', { ...OPERATOR, id: '  ' }],
    ['an ip that is not text', { ...OPERATOR, ip: 5 }],
    ['an osUser that is not text', { ...OPERATOR, osUser: {} }],
    ['an ip left out', { ...OPERATOR, ip: undefined }],
  ])('%s is refused (OPERATOR_REQUIRED)', async (label, resolver) => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(review, 'DELIVERED', manualProof, resolver, 'OPERATOR_REQUIRED', label);
  });
});

describe('L4, Y12 (P6, Q4b): a MANUAL decision, either exit, is an OWNER + OTP action', () => {
  it('MANUAL -> DELIVERED without the OTP is refused, with a SIGNED transfer too (P6)', async () => {
    const admin = await createAdmin('SUPPORT');
    for (const transfer of ['CONFIRMED', 'SIGNED'] as const) {
      const review = await reviewOrder(transfer, 'SENDING');
      await expectRefused(
        review,
        'DELIVERED',
        manualProof,
        adminResolver(admin.id, { otpVerified: false }),
        'OWNER_REQUIRED',
        `support, no otp, ${transfer}`,
      );
    }
  });

  it('MANUAL -> FAILED by a non-owner or without the OTP is refused (Q4b)', async () => {
    const support = await createAdmin('SUPPORT');
    const review = await reviewOrder('EXPIRED');
    await expectRefused(
      review,
      'FAILED',
      manualProof,
      adminResolver(support.id),
      'OWNER_REQUIRED',
      'support',
    );
    await expectRefused(
      review,
      'FAILED',
      manualProof,
      { ...OPERATOR, otpVerified: false },
      'OWNER_REQUIRED',
      'no otp',
    );
    await expectRefused(review, 'FAILED', manualProof, RECONCILER, 'ACTOR_MISMATCH', 'reconciler');
  });

  it('the owner with the OTP can still decide: MANUAL -> FAILED refunds, MANUAL -> DELIVERED delivers', async () => {
    const failed = await reviewOrder('EXPIRED');
    await resolve({
      orderId: failed.order.id,
      to: 'FAILED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(await statusOf(failed.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, failed.user.id)).toBe(0n);
    const delivered = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: delivered.order.id,
      to: 'DELIVERED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(await statusOf(delivered.order.id)).toBe('DELIVERED');
    expect(await sumBalance(db, delivered.user.id)).toBe(-PRICE);
  });
});

describe('Y4, I3 (P3): FRAGMENT_STATUS is for an operator, and not for a message that never landed', () => {
  it('the reconciler cannot carry it (ACTOR_MISMATCH), the owner can', async () => {
    const review = await reviewOrder('CONFIRMED');
    const proof = FRAGMENT_DONE(review.attempt.externalRef);
    await expectRefused(review, 'DELIVERED', proof, RECONCILER, 'ACTOR_MISMATCH', 'reconciler');
    await resolve({ orderId: review.order.id, to: 'DELIVERED', proof, resolver: OPERATOR });
    expect(await statusOf(review.order.id)).toBe('DELIVERED');
  });

  it('an attempt whose transfer is EXPIRED cannot be delivered by it: the message never landed (MISMATCH)', async () => {
    const review = await reviewOrder('EXPIRED');
    await expectRefused(
      review,
      'DELIVERED',
      FRAGMENT_DONE(review.attempt.externalRef),
      OPERATOR,
      'MISMATCH',
      'expired transfer',
    );
  });
});

describe('the reconciler carries only what the chain backs', () => {
  it('TON_TX and TON_NOT_SENT: yes; MANUAL: no', async () => {
    const delivered = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: delivered.order.id,
      to: 'DELIVERED',
      proof: tonTxProof(delivered.transfer),
      resolver: RECONCILER,
    });
    expect(await statusOf(delivered.order.id)).toBe('DELIVERED');
    const failed = await reviewOrder('EXPIRED');
    await resolve({
      orderId: failed.order.id,
      to: 'FAILED',
      proof: notSentProof(failed.transfer),
      resolver: RECONCILER,
    });
    expect(await statusOf(failed.order.id)).toBe('REFUNDED');
    const other = await reviewOrder('CONFIRMED');
    await expectRefused(other, 'DELIVERED', manualProof, RECONCILER, 'ACTOR_MISMATCH', 'manual');
  });
});
