import { Inject, Injectable } from '@nestjs/common';
import { cardTotals, type CardTotals, type Prisma } from '@repo/db';
import {
  RECONCILE_AUDIT,
  tashkentMonthStart,
  type AdminIntentListQuery,
  type AdminPaymentListQuery,
  type AdminReconcileQuery,
  type AdminReviewListQuery,
} from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { dateRange } from '../read/admin-read-view';

type Page = { skip: number; take: number };
const CARD_REF = { select: { id: true, bank: true, last4: true } } as const;
const NEWEST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** Never `providerTxnId` or the redacted provider `raw` (docs/04 `AdminPaymentRow`). */
export const ADMIN_PAYMENT_SELECT = {
  id: true,
  userId: true,
  intentId: true,
  provider: true,
  amountTiyin: true,
  status: true,
  bankMessageId: true,
  reviewId: true,
  createdAt: true,
  confirmedAt: true,
  cancelledAt: true,
} as const satisfies Prisma.PaymentSelect;
export type AdminPaymentSource = Prisma.PaymentGetPayload<{ select: typeof ADMIN_PAYMENT_SELECT }>;

/** Never the pay-link token hash, the idempotency key or the request hash. */
const INTENT_SELECT = {
  id: true,
  userId: true,
  status: true,
  amountTiyin: true,
  baseAmountTiyin: true,
  card: CARD_REF,
  createdAt: true,
  expiresAt: true,
  paidAt: true,
} as const satisfies Prisma.PaymentIntentSelect;

/** Every column but `senderId` / `tgMessageId` / `textSha256`, and the raw text row. */
export const ADMIN_BANK_MESSAGE_SELECT = {
  id: true,
  source: true,
  parseStatus: true,
  rejectReason: true,
  direction: true,
  amountTiyin: true,
  balanceAfterTiyin: true,
  last4: true,
  cardId: true,
  channel: true,
  tgDate: true,
  bankTxnAt: true,
  createdAt: true,
  rawText: { select: { text: true } },
} as const satisfies Prisma.BankMessageSelect;
export type AdminBankMessageSource = Prisma.BankMessageGetPayload<{
  select: typeof ADMIN_BANK_MESSAGE_SELECT;
}>;

export const ADMIN_REVIEW_SELECT = {
  id: true,
  kind: true,
  status: true,
  resolution: true,
  card: CARD_REF,
  intentId: true,
  bankMessageId: true,
  bankMessage: {
    select: { amountTiyin: true, direction: true, bankTxnAt: true, card: CARD_REF },
  },
  createdAt: true,
  resolvedAt: true,
} as const satisfies Prisma.PaymentReviewSelect;
export type AdminReviewSource = Prisma.PaymentReviewGetPayload<{
  select: typeof ADMIN_REVIEW_SELECT;
}>;

const REVIEW_DETAIL_SELECT = {
  ...ADMIN_REVIEW_SELECT,
  bankMessage: { select: { ...ADMIN_BANK_MESSAGE_SELECT, card: CARD_REF } },
  payment: { select: ADMIN_PAYMENT_SELECT },
  note: true,
  resolvedAuditLogId: true,
} as const satisfies Prisma.PaymentReviewSelect;
export type AdminReviewDetailSource = Prisma.PaymentReviewGetPayload<{
  select: typeof REVIEW_DETAIL_SELECT;
}>;

// Every admin read of incoming money (P2P cards, D-31/D-37). Read-only; never the full card
// number (TopupCard.pan is not selected anywhere here).
@Injectable()
export class AdminPaymentsReadRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'TOPUP_CAPACITY_HOLD_SEC'>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async intents(query: AdminIntentListQuery, page: Page) {
    const where: Prisma.PaymentIntentWhereInput = {
      status: query.status,
      userId: query.userId,
      cardId: query.cardId,
      createdAt: dateRange(query),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.paymentIntent.findMany({
        where,
        select: INTENT_SELECT,
        orderBy: [...NEWEST],
        ...page,
      }),
      this.db.paymentIntent.count({ where }),
    ]);
    return { rows, total };
  }

  async payments(query: Omit<AdminPaymentListQuery, 'page' | 'limit'>, page: Page) {
    const where: Prisma.PaymentWhereInput = {
      status: query.status,
      userId: query.userId,
      createdAt: dateRange(query),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.payment.findMany({
        where,
        select: ADMIN_PAYMENT_SELECT,
        orderBy: [...NEWEST],
        ...page,
      }),
      this.db.payment.count({ where }),
    ]);
    return { rows, total };
  }

  /** Open reviews are a queue (oldest first); resolved ones read newest decision first. */
  async reviews(query: AdminReviewListQuery, page: Page) {
    const where: Prisma.PaymentReviewWhereInput = {
      status: query.status,
      kind: query.kind,
      cardId: query.cardId,
      createdAt: dateRange(query),
    };
    const orderBy: Prisma.PaymentReviewOrderByWithRelationInput[] =
      query.status === 'OPEN'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : [{ resolvedAt: 'desc' }, { id: 'desc' }];
    const [rows, total] = await this.db.$transaction([
      this.db.paymentReview.findMany({ where, select: ADMIN_REVIEW_SELECT, orderBy, ...page }),
      this.db.paymentReview.count({ where }),
    ]);
    return { rows, total };
  }

  review(id: string): Promise<AdminReviewDetailSource | null> {
    return this.db.paymentReview.findUnique({ where: { id }, select: REVIEW_DETAIL_SELECT });
  }

  bankMessage(id: string): Promise<AdminBankMessageSource | null> {
    return this.db.bankMessage.findUnique({ where: { id }, select: ADMIN_BANK_MESSAGE_SELECT });
  }

  /** Every card with the shared capacity sums (`cardTotals`, the allocator's own numbers). */
  /** Every card, or the one card (`cardId`: the answer of a card action, S6). */
  cards(now: Date, cardId?: string): Promise<CardTotals[]> {
    return cardTotals(this.db, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: ['VERIFYING', 'ACTIVE', 'FULL', 'DRAINING', 'RETIRED'],
      autoCreditOnly: false,
      holdSec: this.config.TOPUP_CAPACITY_HOLD_SEC,
      ...(cardId === undefined ? {} : { cardId }),
    });
  }

  /** The worker's daily `PAYMENT_RECONCILE` rows, newest first. */
  async reconcileRuns(query: AdminReconcileQuery, page: Page) {
    const where: Prisma.AuditLogWhereInput = { ...RECONCILE_AUDIT, createdAt: dateRange(query) };
    const [rows, total] = await this.db.$transaction([
      this.db.auditLog.findMany({
        where,
        select: { id: true, targetId: true, after: true, createdAt: true },
        orderBy: [...NEWEST],
        ...page,
      }),
      this.db.auditLog.count({ where }),
    ]);
    return { rows, total };
  }
}
