import { Injectable } from '@nestjs/common';
import type { Db } from '../../infra/prisma/db';

/** Review notes that mean "this stored message is not what the pinned bank bot sent" (D-43). */
export const INTEGRITY_NOTES: readonly string[] = ['SENDER_MISMATCH', 'TEXT_HASH_MISMATCH'];

// Why a card's auto-credit is off, by where it is recorded (docs/05 §6). An OPEN review: a chain
// break (also PREDECESSOR_PENDING), an integrity anomaly, a message no attempt could process. A
// CARD_PAUSE AuditLog row not followed by a CARD_RESUME: the owner's own card:pause (actorType
// CLI), or the worker's all-cards SECURITY pause (actorType SYSTEM: a new authorization, an empty
// authorization baseline or a bank-chat anomaly, D-52 r2 M-A; also on a card born during one).
const PAUSING_NOTES = [...INTEGRITY_NOTES, 'PROCESSING_FAILED'];

/** A pause decision (the owner's card:pause or the worker's security pause), not a review. */
export function isPauseDecision(reason: PauseReason): boolean {
  return reason.what === 'CARD_PAUSE' || reason.what.startsWith('SECURITY_PAUSE/');
}

export interface PauseReason {
  /** A review id, or the AuditLog id of a manual CARD_PAUSE. */
  readonly id: string;
  /**
   * `CHAIN_BREAK`, `CHAIN_BREAK/PREDECESSOR_PENDING`, `UNRECOGNIZED/<note>`, `CARD_PAUSE` (the
   * owner's) or `SECURITY_PAUSE/<reason>` (the worker's, D-52 r2).
   */
  readonly what: string;
}

/**
 * Why a card's auto-credit is (still) off. Read under the card lock by review:accept-chain and
 * card:resume: switching auto-credit back on while another reason stands would let money that
 * the worker stopped on purpose be credited automatically again (S8 M1).
 */
@Injectable()
export class CardPauseRepository {
  async reasons(tx: Db, cardId: string, exceptReviewId?: string) {
    const reviews = await tx.paymentReview.findMany({
      where: {
        status: 'OPEN',
        ...(exceptReviewId === undefined ? {} : { id: { not: exceptReviewId } }),
        OR: [{ cardId }, { bankMessage: { cardId } }],
        AND: [
          { OR: [{ kind: 'CHAIN_BREAK' }, { kind: 'UNRECOGNIZED', note: { in: PAUSING_NOTES } }] },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true, kind: true, note: true },
    });
    const found: PauseReason[] = reviews.map((r) => ({
      id: r.id,
      what: r.note === null ? r.kind : `${r.kind}/${r.note}`,
    }));
    const decision = await this.pauseDecision(tx, cardId);
    return decision === null ? found : [...found, decision];
  }

  /** Live (not RETIRED) cards other than this one with auto-credit paused (D-52 D2). */
  otherPausedCount(tx: Db, cardId: string): Promise<number> {
    return tx.topupCard.count({
      where: { id: { not: cardId }, status: { not: 'RETIRED' }, autoCreditPaused: true },
    });
  }

  // The latest pause/resume decision, however old (S8 R1: a pause made before the chain broke must
  // not be lifted by accepting that break). A CARD_PAUSE (the owner's, or the worker's SYSTEM
  // security pause) stands until a CARD_RESUME: accept-chain never switches a card back on over
  // it; only card:resume does.
  private async pauseDecision(tx: Db, cardId: string): Promise<PauseReason | null> {
    const last = await tx.auditLog.findFirst({
      where: {
        targetType: 'TopupCard',
        targetId: cardId,
        action: { in: ['CARD_PAUSE', 'CARD_RESUME'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true, actorType: true, reason: true },
    });
    if (last?.action !== 'CARD_PAUSE') return null;
    const security = last.actorType === 'SYSTEM';
    return { id: last.id, what: security ? `SECURITY_PAUSE/${last.reason}` : 'CARD_PAUSE' };
  }
}
