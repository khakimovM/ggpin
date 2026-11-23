// The read fixtures with the mock journal applied: what a read returns after a mock write. Every
// merged record is parsed with its shared schema again, so a patch can never teach the UI a shape
// the real API does not send.
import {
  AdminAuditRowSchema,
  AdminCardSchema,
  AdminPaymentRowSchema,
  AdminReviewRowSchema,
  AdminUserDetailResponseSchema,
  AdminUserRowSchema,
  type AdminRole,
  type AdminUserDetailResponse,
  type AdminAuditRow,
  type AdminCard,
  type AdminPaymentRow,
  type AdminReviewRow,
  type AdminUserRow,
} from '@repo/shared';
import { CARDS, PAYMENTS, REVIEWS } from './fixtures-payments';
import { AUDIT } from './fixtures-ops';
import { USERS, userDetailFixture } from './fixtures-users';
import { readJournal } from './mock-journal';

export function userView(user: AdminUserRow): AdminUserRow {
  const patch = readJournal().users[user.id];
  if (patch === undefined) return user;
  const balance = BigInt(user.balanceTiyin) + BigInt(patch.balanceDeltaTiyin ?? '0');
  return AdminUserRowSchema.parse({
    ...user,
    isBlocked: patch.isBlocked ?? user.isBlocked,
    purchaseFrozen: patch.purchaseFrozen ?? user.purchaseFrozen,
    balanceTiyin: balance.toString(),
  });
}

export const usersView = (): AdminUserRow[] => USERS.map(userView);

export function cardView(card: AdminCard): AdminCard {
  const patch = readJournal().cards[card.id];
  return patch === undefined ? card : AdminCardSchema.parse({ ...card, ...patch });
}

export const cardsView = (): AdminCard[] => CARDS.map(cardView);

export const paymentsView = (): AdminPaymentRow[] =>
  PAYMENTS.map((payment) => {
    const patch = readJournal().payments[payment.id];
    return patch === undefined ? payment : AdminPaymentRowSchema.parse({ ...payment, ...patch });
  });

export const reviewsView = (): AdminReviewRow[] =>
  REVIEWS.map((review) => {
    const patch = readJournal().reviews[review.id];
    return patch === undefined
      ? review
      : AdminReviewRowSchema.parse({ ...review, status: 'RESOLVED', ...patch });
  });

export const auditView = (): AdminAuditRow[] =>
  [...readJournal().audit, ...AUDIT].map((row) => AdminAuditRowSchema.parse(row));

/** A user's page: the fixture with the journal's state, notes and ended sessions applied. */
export function userDetailView(user: AdminUserRow, role: AdminRole): AdminUserDetailResponse {
  const journal = readJournal();
  const detail = userDetailFixture(userView(user), role);
  return AdminUserDetailResponseSchema.parse({
    ...detail,
    activeSessionsCount: journal.users[user.id]?.sessionsEnded ? 0 : detail.activeSessionsCount,
    notes: journal.notes[user.id] ?? detail.notes,
  });
}
