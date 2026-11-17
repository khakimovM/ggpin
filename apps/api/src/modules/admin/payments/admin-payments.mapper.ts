import type { CardTotals } from '@repo/db';
import {
  receivedUsagePercent,
  type AdminBankMessageResponse,
  type AdminCard,
  type AdminIntentListResponse,
  type AdminPaymentRow,
  type AdminReviewDetailResponse,
  type AdminReviewRow,
} from '@repo/shared';
import { iso, isoOrNull, tiyinOrNull, type AdminReadView } from '../read/admin-read-view';
import type {
  AdminBankMessageSource,
  AdminPaymentSource,
  AdminReviewDetailSource,
  AdminReviewSource,
} from './admin-payments-read.repository';

type IntentSource = {
  id: string;
  userId: string;
  status: AdminIntentListResponse[number]['status'];
  amountTiyin: bigint;
  baseAmountTiyin: bigint | null;
  card: { id: string; bank: 'HUMO' | 'UZCARD'; last4: string } | null;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
};

export function toAdminIntentRow(intent: IntentSource): AdminIntentListResponse[number] {
  return {
    id: intent.id,
    userId: intent.userId,
    status: intent.status,
    amountTiyin: intent.amountTiyin.toString(),
    baseAmountTiyin: tiyinOrNull(intent.baseAmountTiyin),
    card: intent.card,
    createdAt: iso(intent.createdAt),
    expiresAt: iso(intent.expiresAt),
    paidAt: isoOrNull(intent.paidAt),
  };
}

export function toAdminPaymentRow(payment: AdminPaymentSource): AdminPaymentRow {
  return {
    id: payment.id,
    userId: payment.userId,
    intentId: payment.intentId,
    provider: payment.provider,
    amountTiyin: payment.amountTiyin.toString(),
    status: payment.status,
    bankMessageId: payment.bankMessageId,
    reviewId: payment.reviewId,
    createdAt: iso(payment.createdAt),
    confirmedAt: isoOrNull(payment.confirmedAt),
    cancelledAt: isoOrNull(payment.cancelledAt),
  };
}

export function toAdminReviewRow(review: AdminReviewSource): AdminReviewRow {
  return {
    id: review.id,
    kind: review.kind,
    status: review.status,
    resolution: review.resolution,
    // The review's own card, else the card the bank message names (an unknown card has none).
    card: review.card ?? review.bankMessage.card,
    intentId: review.intentId,
    bankMessageId: review.bankMessageId,
    amountTiyin: tiyinOrNull(review.bankMessage.amountTiyin),
    direction: review.bankMessage.direction,
    bankTxnAt: isoOrNull(review.bankMessage.bankTxnAt),
    createdAt: iso(review.createdAt),
    resolvedAt: isoOrNull(review.resolvedAt),
  };
}

/**
 * A bank bot's message. The raw text, the card balance after it and the channel are OWNER-only
 * (`payments.bankMessageRaw`, SA-M5): everyone else gets `null` in those three fields. This is
 * the one place that decides it.
 */
export function toAdminBankMessage(
  message: AdminBankMessageSource,
  view: AdminReadView,
): AdminBankMessageResponse {
  const raw = view.bankMessageRaw;
  return {
    id: message.id,
    source: message.source,
    parseStatus: message.parseStatus,
    rejectReason: message.rejectReason,
    direction: message.direction,
    amountTiyin: tiyinOrNull(message.amountTiyin),
    balanceAfterTiyin: raw ? tiyinOrNull(message.balanceAfterTiyin) : null,
    last4: message.last4,
    cardId: message.cardId,
    channel: raw ? message.channel : null,
    tgDate: iso(message.tgDate),
    bankTxnAt: isoOrNull(message.bankTxnAt),
    createdAt: iso(message.createdAt),
    text: raw ? (message.rawText?.text ?? null) : null,
  };
}

export function toAdminReviewDetail(
  review: AdminReviewDetailSource,
  view: AdminReadView,
): AdminReviewDetailResponse {
  return {
    ...toAdminReviewRow(review),
    bankMessage: toAdminBankMessage(review.bankMessage, view),
    payment: review.payment === null ? null : toAdminPaymentRow(review.payment),
    note: review.note,
    resolvedAuditId: review.resolvedAuditLogId,
  };
}

/** A receiving card: bank and last four digits only, never the full number (D-63 (6)). */
export function toAdminCard(totals: CardTotals): AdminCard {
  const { card } = totals;
  return {
    id: card.id,
    bank: card.bank,
    last4: card.last4,
    holderName: card.holderName,
    status: card.status,
    receiveLimitTiyin: card.receiveLimitTiyin.toString(),
    monthlyLimitTiyin: tiyinOrNull(card.monthlyLimitTiyin),
    receivedTiyin: totals.receivedTiyin.toString(),
    receivedMonthTiyin: totals.receivedMonthTiyin.toString(),
    reservedTiyin: totals.reservedTiyin.toString(),
    usagePercent: receivedUsagePercent(totals),
    autoCreditPaused: card.autoCreditPaused,
    verifiedAt: isoOrNull(card.verifiedAt),
    retiredAt: isoOrNull(card.retiredAt),
    createdAt: iso(card.createdAt),
  };
}
