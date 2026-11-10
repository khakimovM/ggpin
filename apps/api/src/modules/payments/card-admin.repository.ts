import { Injectable } from '@nestjs/common';
import {
  lockBankFeedPause,
  openSecurityPause,
  type CardBank,
  type OpenSecurityPause,
  type Prisma,
  type TopupCard,
} from '@repo/db';
import { SECURITY_PAUSE_AUDIT } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';

export interface NewCardData {
  readonly bank: CardBank;
  readonly pan: string;
  readonly holderName: string;
  readonly receiveLimitTiyin: bigint;
  readonly monthlyLimitTiyin: bigint | null;
  readonly verifyAmountTiyin: bigint;
  /** D-52 D2 (r2): born paused while a security pause is open on a live card. */
  readonly autoCreditPaused: boolean;
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

  /**
   * The lock the worker's all-cards security pause reads its card list under (D-52 r2, review
   * I-A): taken by card:add BEFORE it reads the pause state, so the pause either sees this card
   * committed or card:add sees the pause.
   */
  lockSecurityPause(tx: Db): Promise<void> {
    return lockBankFeedPause(tx);
  }

  /**
   * The newest open security pause on a live card (a SYSTEM CARD_PAUSE for NEW_AUTHORIZATION,
   * AUTH_BASELINE or BANK_CHAT_ANOMALY with no CARD_RESUME after it), or null. A chain-break pause
   * is not one (D2, refined in D-52 r2).
   */
  openSecurityPause(tx: Db): Promise<OpenSecurityPause | null> {
    return openSecurityPause(tx);
  }

  /**
   * The SYSTEM CARD_PAUSE row of a card born under a security pause (D-52 r2, review M-A): the
   * same reason as the open pause, `after.ref` = that pause's AuditLog id. Only the owner's
   * card:resume (CARD_RESUME) lifts it; review:accept-chain keeps the card paused.
   */
  async createBornPausedAudit(tx: Db, cardId: string, pause: OpenSecurityPause): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        ...SECURITY_PAUSE_AUDIT,
        actorId: null,
        ip: null,
        targetId: cardId,
        reason: pause.reason,
        after: {
          autoCreditPaused: true,
          reason: pause.reason,
          ref: pause.auditId,
          bornPaused: true,
        },
      },
      select: { id: true },
    });
    return row.id;
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
