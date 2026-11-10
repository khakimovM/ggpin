import { Injectable, Logger } from '@nestjs/common';
import { TopupCardsRepository } from '../topup-cards.repository';
import { SecurityPauseRepository, type SecurityPauseEvent } from './security-pause.repository';

export type { SecurityPauseEvent } from './security-pause.repository';

/** Locked re-reads for cards added during the pause before giving up (the caller retries). */
const LATE_CARD_ROUNDS = 3;

/**
 * The all-cards security pause (docs/05 §4, S6 I2, D-52 r2): a new authorization of the working
 * account, an empty authorization baseline or a bank-chat anomaly means someone else may read or
 * fake the bank feed. Every card that is not RETIRED (VERIFYING too: it stays paused when it
 * becomes ACTIVE) gets auto-credit off AND a SYSTEM `CARD_PAUSE` AuditLog row with the security
 * reason and the alert refId (review M-A): accept-chain then keeps the card paused, only the
 * owner's card:resume (CARD_RESUME) lifts it, and card:add creates new cards paused while such a
 * pause is open (D2, refined: a chain-break pause alone no longer does).
 *
 * Each card in its own transaction under its advisory lock (the API's key, ONE card lock at a
 * time, S6 I4), so a credit in flight on that card finishes first and the next one sees the
 * pause. A card already under an open security pause is left alone: one row per card per pause
 * (until card:resume), so a flood of anomalies writes nothing more (review M-B). The list of cards
 * to pause is read under the pause lock card:add also takes, and read again after the pauses, so
 * a card committed meanwhile is caught (review I-A). A card that cannot be locked now makes the
 * whole call throw, and the caller tries again on its next round.
 */
@Injectable()
export class AutoCreditPauser {
  private readonly logger = new Logger(AutoCreditPauser.name);

  constructor(
    private readonly pauses: SecurityPauseRepository,
    private readonly cards: TopupCardsRepository,
  ) {}

  /** The number of cards this call put under the security pause (late cards included). */
  async pauseAll(event: SecurityPauseEvent): Promise<number> {
    let paused = 0;
    let ids = await this.pauses.cardsToPause();
    for (let round = 0; ids.length > 0; round += 1) {
      if (round > LATE_CARD_ROUNDS) {
        throw new Error('auto-credit pause: live cards keep appearing unpaused');
      }
      paused += await this.pauseCards(ids, event);
      ids = await this.pauses.cardsToPause();
    }
    return paused;
  }

  /** Pauses these cards, each under its own lock; throws when any of them failed. */
  async pauseCards(ids: readonly string[], event: SecurityPauseEvent): Promise<number> {
    let failed = 0;
    let paused = 0;
    for (const cardId of ids) {
      try {
        const written = await this.pauses.client.$transaction(async (tx) => {
          await this.cards.setLockTimeout(tx);
          await this.cards.lockCard(tx, cardId);
          return this.pauses.pauseCard(tx, cardId, event);
        }, this.cards.cardLockTxOptions());
        if (written) paused += 1;
      } catch (error) {
        failed += 1;
        const name = error instanceof Error ? error.name : 'unknown';
        this.logger.warn(`auto-credit pause card=${cardId} failed: ${name}`);
      }
    }
    // The other cards are paused already; the caller retries the rest on its next round.
    if (failed > 0) throw new Error(`auto-credit pause failed on ${String(failed)} card(s)`);
    return paused;
  }
}
