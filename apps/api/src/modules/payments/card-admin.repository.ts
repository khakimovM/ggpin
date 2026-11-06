import { Injectable } from '@nestjs/common';
import type { CardBank, Prisma, TopupCard } from '@repo/db';
import type { Db } from '../../infra/prisma/db';

export interface NewCardData {
  readonly bank: CardBank;
  readonly pan: string;
  readonly holderName: string;
  readonly receiveLimitTiyin: bigint;
  readonly monthlyLimitTiyin: bigint | null;
  readonly verifyAmountTiyin: bigint;
}

export interface CardAuditData {
  readonly ip: string | null;
  readonly action: string;
  readonly targetId: string;
  readonly before: Prisma.InputJsonValue | null;
  readonly after: Prisma.InputJsonValue;
  readonly reason: string;
}

/** Why a (bank, last4) pair cannot take a new card now (docs/05 §2). */
export type Last4Block = 'LIVE_CARD' | 'RECENTLY_RETIRED' | 'STILL_RESERVED' | null;

// Prisma access of the owner card services. Every method takes the transaction client: each
// service call is ONE transaction with its AuditLog row.
@Injectable()
export class CardAdminRepository {
  findCard(tx: Db, id: string): Promise<TopupCard | null> {
    return tx.topupCard.findUnique({ where: { id } });
  }

  async last4Block(
    tx: Db,
    pair: { readonly bank: CardBank; readonly last4: string },
    now: Date,
    retiredSince: Date,
  ): Promise<Last4Block> {
    const cards = await tx.topupCard.findMany({
      where: { bank: pair.bank, last4: pair.last4 },
      select: { id: true, status: true, retiredAt: true },
    });
    if (cards.some((card) => card.status !== 'RETIRED')) return 'LIVE_CARD';
    if (cards.some((card) => card.retiredAt !== null && card.retiredAt > retiredSince)) {
      return 'RECENTLY_RETIRED';
    }
    if (cards.length === 0) return null;
    const reserved = await tx.paymentIntent.count({
      where: { cardId: { in: cards.map((card) => card.id) }, reservedUntil: { gt: now } },
    });
    return reserved > 0 ? 'STILL_RESERVED' : null;
  }

  createCard(tx: Db, data: NewCardData): Promise<TopupCard> {
    return tx.topupCard.create({
      data: { ...data, last4: data.pan.slice(-4), status: 'VERIFYING' },
    });
  }

  updateCard(tx: Db, id: string, data: Prisma.TopupCardUpdateInput): Promise<TopupCard> {
    return tx.topupCard.update({ where: { id }, data });
  }

  /** Emergency retire: every PENDING request of the card is cancelled and its pay link dies. */
  async cancelPendingOn(tx: Db, cardId: string): Promise<number> {
    const { count } = await tx.paymentIntent.updateMany({
      where: { cardId, provider: 'P2P_CARD', status: 'PENDING' },
      data: { status: 'CANCELLED', payTokenHash: null },
    });
    return count;
  }

  async createAudit(tx: Db, data: CardAuditData): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        // The owner CLI is not a user session: no actor id; the operator name is in `after`.
        actorType: 'CLI',
        actorId: null,
        ip: data.ip,
        action: data.action,
        targetType: 'TopupCard',
        targetId: data.targetId,
        ...(data.before === null ? {} : { before: data.before }),
        after: data.after,
        reason: data.reason,
      },
      select: { id: true },
    });
    return row.id;
  }
}
