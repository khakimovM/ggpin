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
    return [...found, ...(await this.pauseDecisions(tx, cardId))];
  }

  /** Live (not RETIRED) cards other than this one with auto-credit paused (D-52 D2). */
  otherPausedCount(tx: Db, cardId: string): Promise<number> {
    return tx.topupCard.count({
      where: { id: { not: cardId }, status: { not: 'RETIRED' }, autoCreditPaused: true },
    });
  }

  // Every pause decision still standing, however old (S8 R1: a pause made before the chain broke
  // must not be lifted by accepting that break). A CARD_PAUSE (the owner's, or the worker's SYSTEM
  // security pause) stands until a CARD_RESUME: accept-chain never switches a card back on over
  // it; only card:resume does. ALL of them, oldest first, not only the latest: the owner's
  // card:pause on top of a security pause must not hide it from card:resume (final review N1/R-1).
  // Same rule as @repo/db's security-pause predicate: a resume closes only the pauses strictly
  // older than it; one in the very same millisecond stays open (fail closed).
  private async pauseDecisions(tx: Db, cardId: string): Promise<PauseReason[]> {
    const card = { targetType: 'TopupCard', targetId: cardId } as const;
    const resume = await tx.auditLog.findFirst({
      where: { ...card, action: 'CARD_RESUME' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    const pauses = await tx.auditLog.findMany({
      where: {
        ...card,
        action: 'CARD_PAUSE',
        ...(resume === null ? {} : { createdAt: { gte: resume.createdAt } }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, actorType: true, reason: true },
    });
    return pauses.map((p) => ({
      id: p.id,
      what: p.actorType === 'SYSTEM' ? `SECURITY_PAUSE/${String(p.reason)}` : 'CARD_PAUSE',
    }));
  }
}
