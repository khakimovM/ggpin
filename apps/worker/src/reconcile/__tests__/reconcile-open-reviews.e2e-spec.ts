import { useMatcherE2e } from '../../bank-feed/__tests__/matcher-e2e.harness';
import { HOUR, insertMessage, uniqueAmount } from '../../bank-feed/__tests__/matcher-e2e.fixtures';
import { REVIEW_OPEN_MAX_MS } from '../payment-reconcile.service';
import { bootReconcileWorker, type ReconcileWorker } from './reconcile-e2e.harness';

// S9 I-1 on the real ggpin_test DB: `openReviewsOpenedBefore` (the reconcile's reviewOpenOver24h)
// counts an OPEN review opened more than 24 h ago, and neither a younger OPEN one nor an old
// RESOLVED one. The DB is shared, so the count is compared before and after this file's rows
// at the same cutoff. Every review this file opens is RESOLVED at the end of its test, so a
// later run (or another suite's reconcile) never sees it as an old open review.
const t = useMatcherE2e();
let w: ReconcileWorker;
const NOW = new Date();
const CUTOFF = new Date(NOW.getTime() - REVIEW_OPEN_MAX_MS);

beforeAll(async () => {
  w = await bootReconcileWorker(t.env);
});

afterAll(async () => {
  await w.close();
});

/** An OPEN NO_MATCH review of a new synthetic message, opened at `createdAt`. */
async function review(createdAt: Date) {
  const message = await insertMessage(t.db, {
    card: null,
    amountTiyin: uniqueAmount(),
    balanceAfterTiyin: 1_000_000n,
  });
  return t.db.paymentReview.create({
    data: { bankMessageId: message.id, kind: 'NO_MATCH', createdAt },
  });
}

/** Resolves a review the way the owner's decision does (resolution + audit row, the CHECKs). */
async function resolve(reviewId: string) {
  const audit = await t.db.auditLog.create({
    data: {
      actorType: 'CLI',
      action: 'REVIEW_IGNORE',
      targetType: 'PaymentReview',
      targetId: reviewId,
    },
  });
  await t.db.paymentReview.update({
    where: { id: reviewId },
    data: {
      status: 'RESOLVED',
      resolution: 'IGNORED',
      resolvedAuditLogId: audit.id,
      resolvedAt: new Date(),
    },
  });
}

describe('reconcile: OPEN reviews older than 24 h (S9 I-1, real Postgres)', () => {
  it('counts an OPEN review of now-25h; not an OPEN one of now-23h, nor a RESOLVED one of now-25h', async () => {
    const before = await w.repo.openReviewsOpenedBefore(CUTOFF);
    const old = await review(new Date(NOW.getTime() - 25 * HOUR));
    const young = await review(new Date(NOW.getTime() - 23 * HOUR));
    const done = await review(new Date(NOW.getTime() - 25 * HOUR));
    try {
      await resolve(done.id);
      const after = await w.repo.openReviewsOpenedBefore(CUTOFF);
      expect(after.count - before.count).toBe(1);
      // The repository's own query: only `old` of this file's three rows matches it.
      const mine = await t.db.paymentReview.findMany({
        where: {
          id: { in: [old.id, young.id, done.id] },
          status: 'OPEN',
          createdAt: { lt: CUTOFF },
        },
        select: { id: true },
      });
      expect(mine.map((r) => r.id)).toEqual([old.id]);
    } finally {
      await resolve(old.id);
      await resolve(young.id);
    }
  });

  it('examples are the oldest first: the oldest open review is the first example id', async () => {
    // Older than any row another suite can leave (they are opened "now"), so it is first.
    const oldest = await review(new Date(Date.UTC(2001, 0, 1)));
    try {
      const found = await w.repo.openReviewsOpenedBefore(CUTOFF);
      expect(found.ids[0]).toBe(oldest.id);
      expect(found.count).toBeGreaterThanOrEqual(1);
    } finally {
      await resolve(oldest.id);
    }
  });
});
