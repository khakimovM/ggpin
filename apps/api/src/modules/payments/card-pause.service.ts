import { Injectable } from '@nestjs/common';
import { checkedId } from '../../common/admin/admin-input';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { cardInputError, type CardAdminActor } from './card-admin.input';
import { CardAdminService, type CardChange } from './card-admin.service';
import { CardPauseRepository, isPauseDecision, type PauseReason } from './card-pause.repository';

export interface ResumeOptions {
  /** The owner looked at the open pause reasons and resumes anyway (AuditLog.after.override). */
  readonly confirmOverride?: boolean;
}

/**
 * card:pause and card:resume (docs/05 §7). A resume is refused while a pause reason is still
 * open (a chain break, an integrity anomaly, a failed message: their reviews) unless the owner confirms the override: the open reasons are read under the card
 * lock and written to the AuditLog either way.
 */
@Injectable()
export class CardPauseService {
  constructor(
    private readonly cards: CardAdminService,
    private readonly pauses: CardPauseRepository,
    private readonly prisma: PrismaService,
  ) {}

  pauseAutoCredit(cardId: string, reason: string, actor: CardAdminActor): Promise<CardChange> {
    return this.cards.setPaused(cardId, true, this.cards.audit('CARD_PAUSE', reason, actor));
  }

  resumeAutoCredit(
    cardId: string,
    reason: string,
    actor: CardAdminActor,
    options: ResumeOptions = {},
  ): Promise<CardChange> {
    const audit = this.cards.audit('CARD_RESUME', reason, actor);
    return this.cards.setPaused(cardId, false, audit, async (tx: Db) => {
      // The pause being lifted right now (the owner's or a security pause) is not a reason
      // against lifting it: card:resume is exactly that decision (D-52 r2 M-A).
      const open = (await this.pauses.reasons(tx, cardId)).filter((r) => !isPauseDecision(r));
      const override = options.confirmOverride === true;
      if (open.length > 0 && !override) throw cardInputError('card', 'OPEN_PAUSE_REVIEWS');
      return { openPauseReviews: reasonsText(open), override };
    });
  }

  /** Unlocked: how many other live cards are paused too (card:resume warns, D-52 D2). */
  otherPausedCount(cardId: string): Promise<number> {
    return this.pauses.otherPausedCount(this.prisma.client, checkedId('cardId', cardId));
  }

  /** Unlocked: what the CLI shows before it asks (the service checks again under the lock). */
  openReasons(cardId: string): Promise<PauseReason[]> {
    return this.pauses.reasons(this.prisma.client, checkedId('cardId', cardId));
  }
}

/** `CHAIN_BREAK:<id>,UNRECOGNIZED/TEXT_HASH_MISMATCH:<id>` (ids and codes only), or null. */
export function reasonsText(reasons: readonly PauseReason[]): string | null {
  return reasons.length === 0 ? null : reasons.map((r) => `${r.what}:${r.id}`).join(',');
}
