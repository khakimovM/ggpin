import { Injectable } from '@nestjs/common';
import type { Db } from '../../infra/prisma/db';

/** Review notes that mean "this stored message is not what the pinned bank bot sent" (D-43). */
export const INTEGRITY_NOTES: readonly string[] = ['SENDER_MISMATCH', 'TEXT_HASH_MISMATCH'];

// Every reason the worker pauses a card's auto-credit leaves an OPEN review behind (docs/05 §6):
// a chain break (also PREDECESSOR_PENDING), an integrity anomaly, a message no attempt could
// process. The owner's own card:pause leaves an AuditLog row.
const PAUSING_NOTES = [...INTEGRITY_NOTES, 'PROCESSING_FAILED'];

export interface PauseReason {
  /** A review id, or the AuditLog id of a manual CARD_PAUSE. */
  readonly id: string;
  /** `CHAIN_BREAK`, `CHAIN_BREAK/PREDECESSOR_PENDING`, `UNRECOGNIZED/<note>` or `CARD_PAUSE`. */
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
    const manual = await this.manualPause(tx, cardId);
    return manual === null ? found : [...found, { id: manual, what: 'CARD_PAUSE' }];
  }

  // The owner's latest pause/resume decision, however old (S8 R1: a pause made before the chain
  // broke must not be lifted by accepting that break). A CARD_PAUSE stands until a CARD_RESUME:
  // accept-chain never switches a card back on over it.
  private async manualPause(tx: Db, cardId: string): Promise<string | null> {
    const last = await tx.auditLog.findFirst({
      where: {
        targetType: 'TopupCard',
        targetId: cardId,
        action: { in: ['CARD_PAUSE', 'CARD_RESUME'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true },
    });
    return last?.action === 'CARD_PAUSE' ? last.id : null;
  }
}
