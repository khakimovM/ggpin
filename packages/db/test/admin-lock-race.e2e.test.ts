import { describe, expect, it } from 'vitest';
import { resolveNeedsReviewAt } from '../src/orders/needs-review-resolve';
import { db } from './client';
import { expectRefused } from './needs-review-expect';
import { TEST_MS, connect, heldTransaction, pidOf, waitUntilBlocked } from './race-utils';
import {
  NOW,
  adminResolver,
  createAdmin,
  manualProof,
  reviewOrder,
  statusOf,
  tonTxProof,
} from './order-fixtures';

// Audit N3 (D-59 D): the AdminUser row of a resolver is read FOR SHARE, the first lock of
// resolveNeedsReview (lock order AdminUser -> wallet -> order -> attempt -> transfer). A demotion or
// deactivation racing a resolution either waits for it, or commits first and is seen by it.

describe('RA-ADMIN: an admin demoted while their resolution runs', () => {
  it(
    'the demotion waits for the resolution to commit; the resolution was made by an OWNER and says so',
    async () => {
      const admin = await createAdmin('OWNER');
      const review = await reviewOrder('CONFIRMED');
      const other = await connect();
      try {
        const otherPid = await pidOf(other);
        const resolution = heldTransaction((tx) =>
          resolveNeedsReviewAt(
            tx,
            {
              orderId: review.order.id,
              to: 'DELIVERED',
              proof: tonTxProof(review.transfer),
              resolver: adminResolver(admin.id),
            },
            NOW,
          ),
        );
        await resolution.ready;
        const demotion = other
          .query(`UPDATE "AdminUser" SET "role" = 'SUPPORT' WHERE "id" = $1`, [admin.id])
          .then(
            () => 'DEMOTED',
            (error: unknown) => error,
          );
        await waitUntilBlocked(otherPid);
        // The row is still the OWNER row the resolution read: nothing has been demoted yet.
        expect((await db.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe(
          'OWNER',
        );
        resolution.release();
        expect((await resolution.done).ok).toBe(true);
        expect(await demotion).toBe('DEMOTED');
      } finally {
        await other.end();
      }
      expect(await statusOf(review.order.id)).toBe('DELIVERED');
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe(
        'SUPPORT',
      );
      const [audit] = await db.auditLog.findMany({ where: { targetId: review.order.id } });
      expect(audit).toMatchObject({ after: { operator: { id: admin.id, role: 'OWNER' } } });
    },
    TEST_MS,
  );

  it('a demotion that committed first is seen by the resolution (OWNER_REQUIRED)', async () => {
    const admin = await createAdmin('OWNER');
    const review = await reviewOrder('CONFIRMED');
    await db.adminUser.update({ where: { id: admin.id }, data: { role: 'SUPPORT' } });
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      adminResolver(admin.id),
      'OWNER_REQUIRED',
      'demoted',
    );
    await db.adminUser.update({
      where: { id: admin.id },
      data: { role: 'OWNER', isActive: false },
    });
    await expectRefused(
      review,
      'DELIVERED',
      manualProof,
      adminResolver(admin.id),
      'OWNER_REQUIRED',
      'deactivated',
    );
  });
});
