import { describe, expect, it } from 'vitest';
import { LivePayoutError, ReviewProofError, refundFailedOrder, sumBalance } from '../src/index';
import { refundFailedOrderWith } from '../src/orders/order-refund';
import {
  assertNoLivePayout,
  readPayoutState,
  type LivePayoutOptions,
} from '../src/orders/payout-state';
import { db } from './client';
import {
  OPERATOR,
  PRICE,
  addAttempt,
  addTransfer,
  bouncedProof,
  bypassingGuards,
  captureError,
  moveAttempt,
  paidOrder,
  refunds,
  statusOf,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Phase 5 S9f (owner 2026-11-18): an owner's proof (TON_BOUNCED, TON_NOT_DEBITED,
// TON_UNMATCHED_RESOLVED) bound by `resolveNeedsReview` to a transfer settles THAT transfer's own
// late chain fact: a transfer the Z6 hint CONFIRMED that later bounced (BOUNCED + lateDestination)
// is refunded by the owner's TON_BOUNCED. A late fact on ANY OTHER transfer of the order still stops
// the refund, and no automatic path (no owner resolver) gets the exception.

const LATE_DESTINATION = {
  ton: { lateDestination: { verdict: 'DESTINATION_ABORTED', destTxHash: null } },
};
const LATE = { ton: { late: { from: 'EXPIRED', outcome: 'SUSPECT', via: 'SCAN' } } };

/**
 * A PROCESSING order: attempt 1 FAILED with its transfer EXPIRED (`earlier` on its attempt), attempt
 * 2 SENT whose transfer was CONFIRMED and then BOUNCED (`own` on its attempt). With `review` the
 * order is NEEDS_REVIEW, as the classifier leaves it.
 */
async function lateBounce(earlier: object | null, own: object | null) {
  const { user, order } = await paidOrder('PROCESSING');
  const first = await addAttempt(order.id, 'SENDING', { attemptNo: 1 });
  const expired = await addTransfer(first.id, 'EXPIRED');
  await moveAttempt(first.id, 'FAILED');
  const second = await addAttempt(order.id, 'SENDING', { attemptNo: 2 });
  const confirmed = await addTransfer(second.id, 'CONFIRMED');
  await moveAttempt(second.id, 'SENT');
  const bounced = await db.tonTransfer.update({
    where: { id: confirmed.id },
    data: { status: 'BOUNCED' },
  });
  if (earlier !== null) {
    await db.fulfillmentAttempt.update({ where: { id: first.id }, data: { response: earlier } });
  }
  if (own !== null) {
    await db.fulfillmentAttempt.update({ where: { id: second.id }, data: { response: own } });
  }
  await db.order.update({
    where: { id: order.id },
    data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
  });
  return { user, order, first, second, expired, bounced };
}

/** The same order moved to FAILED with attempt 2 closed, as `resolveNeedsReview` does before it refunds. */
async function failedLateBounce(earlier: object | null, own: object | null) {
  const built = await lateBounce(earlier, own);
  await bypassingGuards(async (tx) => {
    await tx.fulfillmentAttempt.update({
      where: { id: built.second.id },
      data: { status: 'FAILED' },
    });
    await tx.order.update({
      where: { id: built.order.id },
      data: { status: 'FAILED', statusReason: 'CONFIRM_TIMEOUT' },
    });
  });
  return built;
}

const refundWith = (orderId: string, options: LivePayoutOptions) =>
  db.$transaction((tx) =>
    refundFailedOrderWith(
      tx,
      { orderId, actor: 'system', note: 'refund after review: TON_BOUNCED' },
      options,
    ),
  );

async function expectNotRefunded(orderId: string, userId: string, status: string, label: string) {
  expect(await statusOf(orderId), label).toBe(status);
  expect(await refunds(orderId), label).toHaveLength(0);
  expect(await sumBalance(db, userId), label).toBe(-PRICE);
}

describe("an owner's proof settles the late fact of its own transfer (S9f, owner 2026-11-18)", () => {
  it('(a) TON_BOUNCED on a Z6-confirmed transfer that bounced late (BOUNCED + lateDestination): refunded', async () => {
    const built = await lateBounce(null, LATE_DESTINATION);
    const result = await resolve({
      orderId: built.order.id,
      to: 'FAILED',
      proof: bouncedProof(built.bounced),
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(built.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, built.user.id)).toBe(0n);
    expect(await refunds(built.order.id)).toHaveLength(1);
  });

  it('(b) the same proof, the late fact on the OTHER transfer: refused by the binding, nothing moved', async () => {
    const built = await lateBounce(LATE, null);
    const error = await captureError(
      resolve({
        orderId: built.order.id,
        to: 'FAILED',
        proof: bouncedProof(built.bounced),
        resolver: OPERATOR,
      }),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('LIVE_PAYOUT');
    await expectNotRefunded(built.order.id, built.user.id, 'NEEDS_REVIEW', '(b) resolve');
    expect(await db.auditLog.count({ where: { targetId: built.order.id } })).toBe(0);
  });

  it('(b) and the guard itself: a proof bound to transfer 2 does not excuse the late fact of transfer 1', async () => {
    const built = await failedLateBounce(LATE, null);
    const ids = [built.bounced.id];
    const error = await captureError(
      refundWith(built.order.id, { provenTransferIds: ids, lateDecidedTransferIds: ids }),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    expect((error as LivePayoutError).detail).toBe('transfer is EXPIRED with a late chain fact');
    await expectNotRefunded(built.order.id, built.user.id, 'FAILED', '(b) guard');
  });

  it('control for the guard: the late fact on the bound transfer itself is excused, the other one is not', async () => {
    // The guard alone: past it, the database still wants the owner's audit row for a BOUNCED
    // refund, which only `resolveNeedsReview` writes ((a) above goes the whole way).
    const own = await failedLateBounce(null, LATE_DESTINATION);
    const other = await failedLateBounce(LATE, null);
    const check = (built: typeof own) =>
      db.$transaction(async (tx) => {
        const ids = [built.bounced.id];
        const state = await readPayoutState(tx, built.order.id);
        expect(state.transfers.filter((t) => t.late)).toHaveLength(1);
        assertNoLivePayout(built.order.id, state, {
          provenTransferIds: ids,
          lateDecidedTransferIds: ids,
        });
      });
    await expect(check(own)).resolves.toBeUndefined();
    await expect(check(other)).rejects.toBeInstanceOf(LivePayoutError);
  });
});

describe('no automatic path gets the exception (S9f, owner 2026-11-18)', () => {
  it('(d) refundFailedOrder (system) on the bound transfer with its own late fact: refused', async () => {
    const built = await failedLateBounce(null, LATE_DESTINATION);
    const error = await captureError(
      db.$transaction((tx) => refundFailedOrder(tx, { orderId: built.order.id, actor: 'system' })),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    await expectNotRefunded(built.order.id, built.user.id, 'FAILED', '(d) system');
  });

  it('(d) the status excused but not the late fact (no owner resolver): refused on the late fact', async () => {
    const built = await failedLateBounce(null, LATE_DESTINATION);
    const error = await captureError(
      refundWith(built.order.id, { provenTransferIds: [built.bounced.id] }),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    expect((error as LivePayoutError).detail).toBe('transfer is BOUNCED with a late chain fact');
    await expectNotRefunded(built.order.id, built.user.id, 'FAILED', '(d) reconciler');
  });
});
