// OWNER writes on P2P top-ups and receiving cards (docs/04 «To‘lovlar (P2P)»): the HTTP form of
// the owner CLI's review:credit, payment:reverse and card:pause|resume|limit|retire.
import {
  AdminCardChangeResponseSchema,
  AdminCreditPreviewResponseSchema,
  AdminPaymentReverseResponseSchema,
  AdminReviewCreditResponseSchema,
  type AdminCardLimitBody,
  type AdminCardPauseBody,
  type AdminCardResumeBody,
  type AdminCardRetireBody,
  type AdminPaymentReverseBody,
  type AdminReviewCreditBody,
} from '@repo/shared';
import { apiFetch } from './client';

const id = (value: string) => encodeURIComponent(value);

function post(path: string, body: unknown, idempotencyKey: string) {
  return { method: 'POST', path, body, idempotencyKey, group: 'payments' } as const;
}

export const creditReview = (reviewId: string, body: AdminReviewCreditBody, key: string) =>
  apiFetch(
    post(`/admin/payments/reviews/${id(reviewId)}/credit`, body, key),
    AdminReviewCreditResponseSchema,
  );

/** What the CLI's review:credit prints first (OWNER): who gets the money, override reasons. */
export const getCreditPreview = (
  reviewId: string,
  target: { userId: string } | { intentId: string },
  signal?: AbortSignal,
) =>
  apiFetch(
    {
      path: `/admin/payments/reviews/${id(reviewId)}/credit-preview`,
      query: target,
      group: 'payments',
      signal,
    },
    AdminCreditPreviewResponseSchema,
  );

export const reversePayment = (paymentId: string, body: AdminPaymentReverseBody, key: string) =>
  apiFetch(
    post(`/admin/payments/${id(paymentId)}/reverse`, body, key),
    AdminPaymentReverseResponseSchema,
  );

export type CardBody =
  | { action: 'cards.pause'; body: AdminCardPauseBody }
  | { action: 'cards.resume'; body: AdminCardResumeBody }
  | { action: 'cards.limit'; body: AdminCardLimitBody }
  | { action: 'cards.retire'; body: AdminCardRetireBody };

const CARD_PATH = {
  'cards.pause': 'pause',
  'cards.resume': 'resume',
  'cards.limit': 'limit',
  'cards.retire': 'retire',
} as const;

export const changeCard = (cardId: string, change: CardBody, key: string) =>
  apiFetch(
    post(`/admin/payments/cards/${id(cardId)}/${CARD_PATH[change.action]}`, change.body, key),
    AdminCardChangeResponseSchema,
  );
