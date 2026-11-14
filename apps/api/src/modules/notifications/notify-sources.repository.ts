import { Injectable } from '@nestjs/common';
import { cardTotals, sumBalance, type CardTotals } from '@repo/db';
import { BANK_FEED_HEARTBEAT_KEY, RECONCILE_AUDIT, tashkentMonthStart } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

const ALL_CARD_STATUSES = ['VERIFYING', 'ACTIVE', 'FULL', 'DRAINING', 'RETIRED'] as const;

// Every database read of the notify consumer: a job carries ids only (notify.ts in shared), and
// the text is built from the rows here. Nothing here writes.
@Injectable()
export class NotifySourcesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** The payment of a TOPUP notification and the addressee (from the Payment row, never the job). */
  payment(id: string) {
    return this.prisma.client.payment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        amountTiyin: true,
        status: true,
        user: { select: { telegramId: true, locale: true, botBlockedAt: true } },
        bankMessage: { select: { card: { select: { bank: true, last4: true } } } },
      },
    });
  }

  balance(userId: string): Promise<bigint> {
    return sumBalance(this.prisma.client, userId);
  }

  review(id: string) {
    return this.prisma.client.paymentReview.findUnique({
      where: { id },
      select: {
        id: true,
        note: true,
        card: { select: { bank: true, last4: true } },
        bankMessage: { select: { amountTiyin: true, rejectReason: true, last4: true } },
      },
    });
  }

  message(id: string) {
    return this.prisma.client.bankMessage.findUnique({
      where: { id },
      select: { id: true, amountTiyin: true, last4: true, cardId: true },
    });
  }

  card(id: string) {
    return this.prisma.client.topupCard.findUnique({
      where: { id },
      select: { id: true, bank: true, last4: true },
    });
  }

  /** The capacity sums of one card NOW, from the query the allocator and the worker use. */
  async cardTotals(cardId: string, now: Date, holdSec: number): Promise<CardTotals | null> {
    const [totals] = await cardTotals(this.prisma.client, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: ALL_CARD_STATUSES,
      autoCreditOnly: false,
      holdSec,
      cardId,
    });
    return totals ?? null;
  }

  auditLog(id: string) {
    return this.prisma.client.auditLog.findUnique({
      where: { id },
      select: { id: true, action: true },
    });
  }

  reconcileRun(day: string) {
    return this.prisma.client.auditLog.findFirst({
      where: { ...RECONCILE_AUDIT, targetId: day },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { after: true },
    });
  }

  /**
   * The order of an ORDER_* notification or a fulfillment alert, and its owner (from the Order row,
   * never the job). Only what the texts print: no price, cost, FX, provider handle or idempotency
   * key (an amount in a text comes from the REFUND entry, orderRefund).
   */
  order(id: string) {
    return this.prisma.client.order.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        statusReason: true,
        deliveredAt: true,
        quantity: true,
        // The whole stored recipient JSON is selected (Prisma cannot pick keys inside a Json
        // column), but only its storedRecipientView (name, @username) is ever printed.
        recipient: true,
        product: { select: { nameUz: true, nameRu: true } },
        sku: { select: { labelUz: true, labelRu: true } },
        user: { select: { telegramId: true, locale: true, botBlockedAt: true } },
      },
    });
  }

  /** The automatic (or full admin) refund of an order: `ORDER/<orderId>` REFUND, rules/40. */
  orderRefund(orderId: string) {
    return this.prisma.client.ledgerEntry.findUnique({
      where: { refType_refId_kind: { refType: 'ORDER', refId: orderId, kind: 'REFUND' } },
      select: { amountTiyin: true },
    });
  }

  /** A TON transfer of a wallet alert: seqno, amount, destination and its order's # only. */
  tonTransfer(id: string) {
    return this.prisma.client.tonTransfer.findUnique({
      where: { id },
      select: {
        id: true,
        seqno: true,
        amountNanoTon: true,
        toAddress: true,
        attempt: { select: { order: { select: { id: true, number: true } } } },
      },
    });
  }

  walletSnapshot(id: string) {
    return this.prisma.client.walletSnapshot.findUnique({
      where: { id },
      select: { id: true, address: true, nanoTon: true },
    });
  }

  /** The listener heartbeat (epoch ms) or null. */
  heartbeat(): Promise<string | null> {
    return this.redis.client.get(BANK_FEED_HEARTBEAT_KEY);
  }
}
