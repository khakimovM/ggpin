import { Injectable, Logger } from '@nestjs/common';
import { alertRef, isCardSilent } from '@repo/shared';
import { BankFeedNotifier } from './bank-feed-notifier';
import { CardSilenceRepository } from './card-silence.repository';

export interface CardSilenceResult {
  /** `cardSilent` alerts handed to the notify queue by this run (new silent periods only). */
  readonly alerted: number;
  /** Alerts that could not be queued: the next sweep tries again. */
  readonly failed: number;
}

/** Silent periods this process already queued; BullMQ's job id dedupes after a restart too. */
const SENT_MEMORY = 500;

/**
 * Card silence (docs/05 §2 "Jimlik aniqlanishi", D-52 r2 review M-C), a step of the every-minute
 * `topup-expire` sweep: an ACTIVE card with no CREDIT for BANK_FEED_DEFAULTS.SILENCE_ALERT_HOURS
 * (6) DAYTIME hours (Asia/Tashkent 00:00-08:00 not counted, `isCardSilent`) raises `cardSilent`.
 * A silent listener (a paging bug, a muted chat) and a quiet shop look the same from here, so the
 * owner checks. One alert per silent period: the refId is the card and its last credit time, so
 * it repeats only after a new credit ends the period (or after the 30-day notify dedupe). No env
 * setting: the hours are the documented constant. Logs: card ids and counts only.
 */
@Injectable()
export class CardSilenceService {
  private readonly logger = new Logger(CardSilenceService.name);
  private readonly sent = new Set<string>();

  constructor(
    private readonly repo: CardSilenceRepository,
    private readonly notifier: BankFeedNotifier,
  ) {}

  async run(now: Date): Promise<CardSilenceResult> {
    let alerted = 0;
    let failed = 0;
    for (const { cardId, since } of await this.repo.activeCardsQuietSince()) {
      if (!isCardSilent(since, now)) continue;
      const ref = alertRef.cardSilent(cardId, since);
      if (this.sent.has(ref)) continue;
      try {
        await this.notifier.alert('cardSilent', ref);
        this.remember(ref);
        alerted += 1;
      } catch (error) {
        failed += 1;
        const name = error instanceof Error ? error.name : 'unknown';
        this.logger.warn(`card silence alert card=${cardId} not queued: ${name}`);
      }
    }
    return { alerted, failed };
  }

  private remember(ref: string): void {
    this.sent.add(ref);
    if (this.sent.size <= SENT_MEMORY) return;
    const oldest = this.sent.values().next();
    if (oldest.done !== true) this.sent.delete(oldest.value);
  }
}
