import { Injectable } from '@nestjs/common';
import {
  hasOpenSecurityPause,
  liveCardsWithoutSecurityPause,
  lockBankFeedPause,
  type Tx,
} from '@repo/db';
import { SECURITY_PAUSE_AUDIT, type SecurityPauseReason } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** One security event: why every card is paused and the owner alert's refId (D-52 r2, M-A). */
export interface SecurityPauseEvent {
  readonly reason: SecurityPauseReason;
  readonly ref: string;
}

/**
 * The reads and writes of the all-cards security pause (rules/20: Prisma only in repositories).
 * The predicate itself lives in @repo/db (security-pause.ts), shared with the API's card:add.
 */
@Injectable()
export class SecurityPauseRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client() {
    return this.prisma.client;
  }

  /**
   * Live cards still without an open security pause, read under the pause lock that card:add
   * takes (D-52 r2, review I-A): a card:add that read "no pause open" before our first card was
   * paused commits first, and its card is in this list. Only this read holds the lock.
   */
  cardsToPause(): Promise<string[]> {
    return this.prisma.client.$transaction(async (tx) => {
      await lockBankFeedPause(tx);
      return liveCardsWithoutSecurityPause(tx);
    });
  }

  /**
   * In the caller's card-locked transaction: auto-credit off and the SYSTEM `CARD_PAUSE` row
   * (reason = the security code, after.ref = the alert refId), also when the card was already
   * paused for another reason (a chain break: accept-chain must not lift this one). A card under
   * an open security pause already, or RETIRED meanwhile, is left as it is: false.
   */
  async pauseCard(tx: Tx, cardId: string, event: SecurityPauseEvent): Promise<boolean> {
    const card = await tx.topupCard.findUnique({
      where: { id: cardId },
      select: { status: true, autoCreditPaused: true },
    });
    if (card === null || card.status === 'RETIRED') return false;
    if (await hasOpenSecurityPause(tx, cardId)) return false;
    if (!card.autoCreditPaused) {
      await tx.topupCard.update({ where: { id: cardId }, data: { autoCreditPaused: true } });
    }
    await tx.auditLog.create({
      data: {
        ...SECURITY_PAUSE_AUDIT,
        actorId: null,
        ip: null,
        targetId: cardId,
        reason: event.reason,
        before: { autoCreditPaused: card.autoCreditPaused },
        after: {
          autoCreditPaused: true,
          reason: event.reason,
          ref: event.ref,
          alreadyPaused: card.autoCreditPaused,
        },
      },
    });
    return true;
  }
}
