import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';
import { BankFeedNotifier } from './bank-feed-notifier';
import { CardDrainRepository } from './card-drain.repository';
import { LATE_STORED_AFTER_MS } from './match-rules';
import { TopupCardsRepository } from './topup-cards.repository';

export interface CardDrainResult {
  /** DRAINING cards this run moved to RETIRED. */
  readonly retired: number;
  /** Cards that could not be checked (busy card lock, an error): the next run retries. */
  readonly skipped: number;
  /** Cards with every reservation over that stay DRAINING for an undecided message. */
  readonly heldByMessage: number;
  /** `cardDrained` alerts that could not be queued (retried by the next runs, see below). */
  readonly alertsFailed: number;
}

/** How long after the retirement its alert is queued again (a lost job is recovered). */
export const CARD_DRAINED_ALERT_RETRY_MS = 60 * 60 * 1000;

type Verdict = 'RETIRED' | 'HELD_BY_MESSAGE' | 'KEPT';

/**
 * DRAINING -> RETIRED (docs/05 §2, roadmap phase 4): an ordinary `card:retire` leaves the card
 * DRAINING so the requests already issued on it stay payable. The card retires here, a step of
 * the every-minute `topup-expire` sweep, once no request of it (any status) has
 * `reservedUntil >= now - LATE_STORED_AFTER_MS` and no message on it awaits a decision.
 *
 * Why the LATE_STORED_AFTER_MS margin: the matcher picks a request by the message's Telegram
 * date (`reservedUntil >= tgDate`), and a message stored up to that long after its date is still
 * decided automatically. Retiring at `reservedUntil` would turn such a payment, made in time,
 * into a CARD_RETIRED review; with the margin the retirement changes no automatic decision (a
 * message stored later than that is a D-47 LATE_STORED review anyway).
 *
 * Per card ONE transaction under the card's advisory lock (the API's key, the only card lock
 * held, the matcher's lock_timeout and a transaction timeout above it): status, reservations and
 * undecided messages are read again inside it, so a payment being credited on the card right
 * now (the matcher holds the same lock and may extend a PAID request's `reservedUntil`) or a card
 * command either finishes first and is seen, or waits. A parallel sweep finds the card RETIRED
 * and does nothing: one transition, one AuditLog row (SYSTEM, CARD_RETIRE_DRAINED). The owner's
 * `cardDrained` alert is queued after the commit with a job id stable per card, and again on
 * every run for CARD_DRAINED_ALERT_RETRY_MS, so a lost job is recovered and still sent once.
 *
 * A card held by an undecided message is logged by id every run: that message also shows up as
 * `missingOutcome` in the daily reconciliation (or `messageStuck`); `card:retire --emergency`
 * retires the card by force. Money arriving after the retirement goes to the matcher's existing
 * CARD_RETIRED review. The sweep moves no money; logs carry card ids and counts only.
 */
@Injectable()
export class CardDrainService {
  private readonly logger = new Logger(CardDrainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: TopupCardsRepository,
    private readonly drain: CardDrainRepository,
    private readonly notifier: BankFeedNotifier,
  ) {}

  async run(now: Date = new Date()): Promise<CardDrainResult> {
    const horizon = new Date(now.getTime() - LATE_STORED_AFTER_MS);
    let skipped = 0;
    let heldByMessage = 0;
    const retired: string[] = [];
    for (const cardId of await this.drain.drainedCandidates(this.prisma.client, horizon)) {
      try {
        const verdict = await this.retireIfDrained(cardId, now, horizon);
        if (verdict === 'RETIRED') retired.push(cardId);
        if (verdict === 'HELD_BY_MESSAGE') {
          heldByMessage += 1;
          this.logger.warn(`card-drain card=${cardId} held by an undecided message`);
        }
      } catch (error) {
        skipped += 1;
        this.logger.warn(`card-drain card=${cardId} not checked: ${errorName(error)}`);
      }
    }
    const alertsFailed = await this.raiseAlerts(retired, now);
    return { retired: retired.length, skipped, heldByMessage, alertsFailed };
  }

  private retireIfDrained(cardId: string, now: Date, horizon: Date): Promise<Verdict> {
    return this.prisma.client.$transaction(async (tx): Promise<Verdict> => {
      await this.cards.setLockTimeout(tx);
      await this.cards.lockCard(tx, cardId);
      if ((await this.drain.statusOf(tx, cardId)) !== 'DRAINING') return 'KEPT';
      if (await this.drain.hasLiveReservation(tx, cardId, horizon)) return 'KEPT';
      if (await this.drain.hasUndecidedMessage(tx, cardId)) return 'HELD_BY_MESSAGE';
      await this.drain.retire(tx, cardId, now);
      return 'RETIRED';
    }, this.cards.cardLockTxOptions());
  }

  /** This run's retirements plus the recent ones (a retry of a lost job; deduplicated by id). */
  private async raiseAlerts(retired: readonly string[], now: Date): Promise<number> {
    const ids = new Set(retired);
    try {
      const since = new Date(now.getTime() - CARD_DRAINED_ALERT_RETRY_MS);
      for (const id of await this.drain.drainedSince(this.prisma.client, since)) ids.add(id);
    } catch (error) {
      this.logger.warn(`card-drain recent retirements not read: ${errorName(error)}`);
    }
    let failed = 0;
    for (const cardId of ids) {
      try {
        await this.notifier.alert('cardDrained', cardId);
      } catch (error) {
        failed += 1;
        this.logger.warn(`card-drain card=${cardId} alert not queued: ${errorName(error)}`);
      }
    }
    return failed;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
