// P2P payments fixtures (Q9: requests, payments, review queue, cards, bank messages, reconcile).
import {
  AdminBankMessageResponseSchema,
  AdminCardListResponseSchema,
  AdminIntentListResponseSchema,
  AdminPaymentListResponseSchema,
  AdminReconcileResponseSchema,
  AdminReviewListResponseSchema,
  RECONCILE_MISMATCH_CODES,
  type AdminBankMessageResponse,
  type AdminRole,
} from '@repo/shared';
import { ago, mid } from './data-common';

const HUMO = { id: mid('card', 1), bank: 'HUMO', last4: '4417' } as const;
const UZCARD = { id: mid('card', 2), bank: 'UZCARD', last4: '0921' } as const;

export const INTENTS = AdminIntentListResponseSchema.parse(
  (
    [
      ['PAID', '10000000', HUMO, 2, true],
      ['PENDING', '5000037', UZCARD, 6, false],
      ['PAID', '5000012', HUMO, 15, true],
      ['EXPIRED', '20000041', HUMO, 70, false],
      ['CANCELLED', '15000000', UZCARD, 95, false],
      ['PAID', '60000000', UZCARD, 140, true],
    ] as const
  ).map(([status, amountTiyin, card, minutes, paid], index) => ({
    id: mid('int', index + 1),
    userId: mid('user', index + 1),
    status,
    amountTiyin,
    baseAmountTiyin: amountTiyin.slice(0, -2) + '00',
    card,
    createdAt: ago(minutes),
    expiresAt: ago(minutes - 30),
    paidAt: paid ? ago(minutes - 1) : null,
  })),
);

export const PAYMENTS = AdminPaymentListResponseSchema.parse(
  (
    [
      ['CONFIRMED', '10000000', 1, 1, null],
      ['CONFIRMED', '5000012', 3, 2, null],
      ['CONFIRMED', '60000000', 6, 3, null],
      ['CANCELLED', '15000000', null, 4, 1],
      ['CONFIRMED', '3000000', null, 5, 2],
    ] as const
  ).map(([status, amountTiyin, intent, message, review], index) => ({
    id: mid('pay', index + 1),
    userId: mid('user', index + 1),
    intentId: intent === null ? null : mid('int', intent),
    provider: 'P2P_CARD',
    amountTiyin,
    status,
    bankMessageId: mid('msg', message),
    reviewId: review === null ? null : mid('rev', review),
    createdAt: ago(index * 30 + 1),
    confirmedAt: status === 'CONFIRMED' ? ago(index * 30) : null,
    cancelledAt: status === 'CANCELLED' ? ago(index * 30) : null,
  })),
);

export const REVIEWS = AdminReviewListResponseSchema.parse(
  (
    [
      ['NO_MATCH', 'OPEN', null, HUMO, '7500000', 'CREDIT', 25],
      ['CANCELLED_LATE', 'OPEN', null, UZCARD, '15000000', 'CREDIT', 95],
      ['UNRECOGNIZED', 'OPEN', null, null, null, null, 180],
      ['DAILY_LIMIT', 'RESOLVED', 'CREDITED_USER', HUMO, '3000000', 'CREDIT', 900],
    ] as const
  ).map(([kind, status, resolution, card, amountTiyin, direction, minutes], index) => ({
    id: mid('rev', index + 1),
    kind,
    status,
    resolution,
    card,
    intentId: index === 1 ? mid('int', 5) : null,
    bankMessageId: mid('msg', index + 6),
    amountTiyin,
    direction,
    bankTxnAt: amountTiyin === null ? null : ago(minutes + 1),
    createdAt: ago(minutes),
    resolvedAt: status === 'RESOLVED' ? ago(minutes - 60) : null,
  })),
);

export const CARDS = AdminCardListResponseSchema.parse([
  {
    ...HUMO,
    holderName: 'AZIZ O.',
    status: 'ACTIVE',
    receiveLimitTiyin: '50000000000',
    monthlyLimitTiyin: '30000000000',
    receivedTiyin: '31200000000',
    receivedMonthTiyin: '12400000000',
    reservedTiyin: '25000000',
    usagePercent: 62,
    autoCreditPaused: false,
    verifiedAt: ago(40_000),
    retiredAt: null,
    createdAt: ago(41_000),
  },
  {
    ...UZCARD,
    holderName: 'AZIZ O.',
    status: 'FULL',
    receiveLimitTiyin: '20000000000',
    monthlyLimitTiyin: null,
    receivedTiyin: '16400000000',
    receivedMonthTiyin: '9800000000',
    reservedTiyin: '0',
    usagePercent: 82,
    autoCreditPaused: true,
    verifiedAt: ago(30_000),
    retiredAt: null,
    createdAt: ago(31_000),
  },
]);

// The raw text only for OWNER (payments.bankMessageRaw); the others get null in three fields.
export function bankMessageFixture(id: string, role: AdminRole): AdminBankMessageResponse {
  const owner = role === 'OWNER';
  const unrecognized = id === mid('msg', 8);
  return AdminBankMessageResponseSchema.parse({
    id,
    source: 'HUMO_BOT',
    parseStatus: unrecognized ? 'UNRECOGNIZED' : 'PARSED',
    rejectReason: null,
    direction: unrecognized ? null : 'CREDIT',
    amountTiyin: unrecognized ? null : '7500000',
    balanceAfterTiyin: owner && !unrecognized ? '412000000' : null,
    last4: unrecognized ? null : '4417',
    cardId: unrecognized ? null : HUMO.id,
    channel: owner ? 'HUMO bot' : null,
    tgDate: ago(26),
    bankTxnAt: unrecognized ? null : ago(26),
    createdAt: ago(25),
    text: owner
      ? unrecognized
        ? '<b>Diqqat</b>: kartangiz bo‘yicha xabar\n*4417 · noma’lum format'
        : '🟢 Пополнение\n➕ 75 000.00 UZS\n💳 HUMO *4417\n🕓 14:47 17.11.2026\n💰 4 120 000.00 UZS'
      : null,
  });
}

const zeros = Object.fromEntries(RECONCILE_MISMATCH_CODES.map((code) => [code, 0]));
const noExamples = Object.fromEntries(RECONCILE_MISMATCH_CODES.map((code) => [code, []]));

export const RECONCILE = AdminReconcileResponseSchema.parse(
  [0, 1, 2, 3].map((daysAgo) => {
    const bad = daysAgo === 0;
    const day = new Date(Date.parse(ago(daysAgo * 1440 + 360)) + 5 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    return {
      day,
      auditId: mid('aud', 90 + daysAgo),
      createdAt: ago(daysAgo * 1440 + 360),
      ok: !bad,
      checkedMessages: 412 - daysAgo * 37,
      debits: 3 + daysAgo,
      openReviews: bad ? 2 : 0,
      historyScan: bad ? 'PARTIAL' : 'OK',
      mismatches: bad ? { ...zeros, creditUnaccounted: 1, reviewOpenOver24h: 1 } : zeros,
      examples: bad
        ? { ...noExamples, creditUnaccounted: [mid('msg', 7)], reviewOpenOver24h: [mid('rev', 2)] }
        : noExamples,
    };
  }),
);
