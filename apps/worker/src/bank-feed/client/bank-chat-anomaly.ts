import { Injectable, Logger } from '@nestjs/common';
import {
  BANK_CHAT_ANOMALY_REASONS,
  alertRef,
  type BankChatAnomalyReason,
  type BankFeedSource,
} from '@repo/shared';
import { BankFeedNotifier } from '../bank-feed-notifier';
import { AutoCreditPauser } from './auto-credit-pauser';
import { BankFeedAccountRepository } from './bank-feed-account.repository';
import type { BankFeedMessage } from './bank-feed-client';
import { HourlyCounter } from './hourly-counter';

/** The anomaly reason of an ingest reject reason, or null when it is not one (D-52, L-1). */
export function bankChatAnomalyOf(reason: string | null): BankChatAnomalyReason | null {
  return BANK_CHAT_ANOMALY_REASONS.find((r) => r === reason) ?? null;
}

/** Alert refIds this process queued (BullMQ's job id dedupes anyway); oldest forgotten first. */
const SENT_MEMORY = 50;

/**
 * The working account only READS the two bank bots (E-19). A message it wrote itself (OUTGOING,
 * or an edit of one), or one from another sender / a non-bot in a bank bot's chat means someone
 * else uses the account or the chat: a security event (D-52, review L-1). The owner alert goes
 * first (`bankChatAnomaly`, refId = source, reason and the HOUR: one alert an hour however many
 * messages, review M-B; the Telegram id is in the log and on the stored REJECTED row), then
 * auto-credit is paused on ALL cards (AutoCreditPauser: a card already under the security pause
 * is not written again, so a flood costs one locked read per message). It throws when either step
 * fails; the caller (ingest, before it stores the message) then stores nothing, so the next poll
 * does both again.
 *
 * Setup messages are not an anomaly (D-52 r2, review I-C): the owner's own /start, contact and
 * card-linking messages in a bot chat, written (or last edited) BEFORE the working account was
 * bound (BankFeedAccount.createdAt, the first `live` start), are stored REJECTED (OUTGOING) and
 * reviewed like any rejected message, without an alert storm or a pause. After the binding every
 * outgoing message is an anomaly again (runbook: no writing in the bot chats after setup).
 */
@Injectable()
export class BankChatAnomalyGuard {
  private readonly logger = new Logger(BankChatAnomalyGuard.name);
  private readonly sent = new Set<string>();
  private readonly logged = new HourlyCounter();

  constructor(
    private readonly pauser: AutoCreditPauser,
    private readonly notifier: BankFeedNotifier,
    private readonly accounts: BankFeedAccountRepository,
  ) {}

  /** OUTGOING written before the binding: a setup message, not an anomaly. Fail closed: unbound -> false. */
  async isSetupMessage(
    reason: BankChatAnomalyReason,
    message: Pick<BankFeedMessage, 'date' | 'editDate'>,
  ): Promise<boolean> {
    if (reason !== 'OUTGOING') return false;
    const boundAt = await this.accounts.boundAt();
    if (boundAt === null) return false;
    const lastTouched = message.editDate ?? message.date;
    return lastTouched < boundAt;
  }

  async raise(
    source: BankFeedSource,
    reason: BankChatAnomalyReason,
    tgMessageId: bigint,
    now: Date = new Date(),
  ): Promise<void> {
    const ref = alertRef.bankChatAnomaly(source, reason, now);
    if (!this.sent.has(ref)) {
      await this.notifier.alert('bankChatAnomaly', ref);
      this.remember(ref);
    }
    const paused = await this.pauser.pauseAll({ reason: 'BANK_CHAT_ANOMALY', ref });
    const hit = this.logged.hit(`${source}_${reason}`, now);
    if (hit.logNow || paused > 0) {
      this.logger.error(
        `bank-feed source=${source} ${reason} message=${tgMessageId.toString()}: the working ` +
          `account must only read; ${String(paused)} card(s) newly paused ` +
          `(events in its previous logged hour: ${String(hit.previousLoggedHourCount)})`,
      );
    }
  }

  private remember(ref: string): void {
    this.sent.add(ref);
    if (this.sent.size <= SENT_MEMORY) return;
    const oldest = this.sent.values().next();
    if (oldest.done !== true) this.sent.delete(oldest.value);
  }
}
