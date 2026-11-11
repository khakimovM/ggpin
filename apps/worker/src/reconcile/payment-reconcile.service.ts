import { Inject, Injectable } from '@nestjs/common';
import {
  RECONCILE_MISMATCH_CODES,
  isOverReceiveLimit,
  tashkentDayKey,
  type ReconcileMismatchCode,
} from '@repo/shared';
import { BankFeedNotifier } from '../bank-feed/bank-feed-notifier';
import { isPastCapacityHold } from '../bank-feed/match-rules';
import { OUTCOME_SETTLE_MS } from '../bank-feed/orphan-requeue.service';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { HistoryRescanService, type HistoryRescan } from './history-rescan.service';
import {
  chainBreaks,
  creditUnaccounted,
  debitsByCard,
  findingOf,
  firstParsedPerCard,
} from './reconcile-checks';
import { ReconcileRepository, type Finding, type WindowMessage } from './reconcile.repository';

/** The window the re-scan and the message checks cover (docs/05 §10). */
export const RECONCILE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** An OPEN review older than this makes the day a mismatch (S9 I-1). */
export const REVIEW_OPEN_MAX_MS = 24 * 60 * 60 * 1000;

export interface ReconcileReport {
  readonly day: string;
  readonly auditId: string;
  readonly ok: boolean;
  readonly history: HistoryRescan;
  readonly mismatches: Readonly<Record<ReconcileMismatchCode, Finding>>;
  readonly checkedMessages: number;
  readonly debits: number;
  readonly openReviews: number;
  /** Chain gaps the owner already resolved (information, not a mismatch). */
  readonly chainBreaksReviewed: number;
}

/**
 * `payment-reconcile` (daily 03:00 Asia/Tashkent, docs/05 §10): first the 48 h history re-scan
 * (a missed message is stored and queued like any other), then the checks over the window and
 * the state: every message has its decision (all time, not only the window), every P2P_CARD
 * payment its message, each card's
 * received CREDIT sum is accounted for, the balance chain is whole, no PENDING request outlived
 * its grace, no late payment pushed its card over the limit (D-42 residual risk); plus the DEBIT
 * summary, the open reviews (one OPEN for more than 24 h is a mismatch: money waiting for the
 * owner is never a clean day, S9 I-1), raw texts kept past their purge date (purgeOverdue)
 * and the requests whose grace ended. One AuditLog row
 * (RECONCILE_AUDIT, targetId = the Tashkent day) and one alert: `reconcileOk` only when nothing
 * was found AND the history was read (`historyScan: ok`), `reconcileMismatch` otherwise.
 *
 * It moves no money and changes no state itself. A second run on the same day writes another
 * audit row but its alert has the same job id (`alert-<kind>-<day>`), so the owner hears once
 * per verdict a day; if the verdict changed (ok, then a mismatch) the other kind is sent, on
 * purpose: something new was found.
 */
@Injectable()
export class PaymentReconcileService {
  constructor(
    private readonly repo: ReconcileRepository,
    private readonly history: HistoryRescanService,
    private readonly notifier: BankFeedNotifier,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async run(now: Date = new Date()): Promise<ReconcileReport> {
    const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
    const history = await this.history.rescan(since, now);
    const messages = await this.repo.messagesSince(since);
    const recovered = [
      ...history.sources.HUMO_BOT.recovered,
      ...history.sources.UZCARD_BOT.recovered,
    ];
    const settledBefore = new Date(now.getTime() - OUTCOME_SETTLE_MS);
    const chain = chainBreaks(messages, await this.firstLinks(messages));
    const mismatches: Record<ReconcileMismatchCode, Finding> = {
      recovered: findingOf(recovered),
      missingOutcome: await this.repo.messagesWithoutOutcome(settledBefore),
      creditUnaccounted: creditUnaccounted(messages, settledBefore),
      paymentWithoutMessage: await this.repo.paymentsWithoutMessage(),
      chainBreak: chain.breaks,
      pendingPastGrace: await this.repo.pendingPastGrace(now),
      lateOverLimit: await this.lateOverLimit(since, now),
      reviewOpenOver24h: await this.repo.openReviewsOpenedBefore(
        new Date(now.getTime() - REVIEW_OPEN_MAX_MS),
      ),
      // The purge job itself is silent (logs only): a kept text past its date surfaces here.
      purgeOverdue: await this.repo.purgeOverdue(),
    };
    const total = RECONCILE_MISMATCH_CODES.reduce((n, code) => n + mismatches[code].count, 0);
    const ok = total === 0 && history.state === 'ok';
    const byCard = debitsByCard(messages);
    const debits = Object.values(byCard).reduce((n, c) => n + c.count, 0);
    const openReviews = await this.repo.openReviews();
    const day = tashkentDayKey(now);
    const auditId = await this.repo.writeAudit(day, {
      count: ok ? messages.length : total,
      debits,
      openReviews,
      historyScan: history.state,
      history: historyAudit(history),
      window: { since: since.toISOString(), until: now.toISOString() },
      checkedMessages: messages.length,
      mismatches: Object.fromEntries(RECONCILE_MISMATCH_CODES.map((c) => [c, mismatches[c].count])),
      examples: Object.fromEntries(
        RECONCILE_MISMATCH_CODES.map((c) => [c, [...mismatches[c].ids]]),
      ),
      debitsByCard: byCard,
      chainBreaksReviewed: chain.reviewed,
      possibleReversals: await this.repo.possibleReversalsSince(since),
      graceEnded: await this.repo.graceEnded(since, now),
    });
    await this.notifier.alert(ok ? 'reconcileOk' : 'reconcileMismatch', day);
    return {
      day,
      auditId,
      ok,
      history,
      mismatches,
      checkedMessages: messages.length,
      debits,
      openReviews,
      chainBreaksReviewed: chain.reviewed,
    };
  }

  /** Each card's balance before its first window message (null: the card's first message). */
  private async firstLinks(
    messages: readonly WindowMessage[],
  ): Promise<Map<string, bigint | null>> {
    const links = new Map<string, bigint | null>();
    for (const [cardId, firstId] of firstParsedPerCard(messages)) {
      const previous = await this.repo.previousParsed(cardId, firstId);
      links.set(cardId, previous?.balanceAfterTiyin ?? null);
    }
    return links;
  }

  /**
   * D-42 residual risk: an automatic payment of the window that came after its request stopped
   * holding card capacity (`expiresAt + TOPUP_CAPACITY_HOLD_SEC`), on a card that is now over
   * its receive limit. The payment ids.
   */
  private async lateOverLimit(since: Date, now: Date): Promise<Finding> {
    const late = (await this.repo.paymentsSince(since)).filter((p) => {
      const intent = p.intent;
      return (
        intent !== null &&
        intent.paidAt !== null &&
        p.bankMessage?.cardId != null &&
        isPastCapacityHold(intent, intent.paidAt, this.config.TOPUP_CAPACITY_HOLD_SEC)
      );
    });
    const cardIds = [...new Set(late.map((p) => p.bankMessage?.cardId ?? ''))].filter(
      (id) => id !== '',
    );
    const over = new Set(
      (await this.repo.liveCardTotals(cardIds, now)).flatMap((t) =>
        t !== undefined && isOverReceiveLimit(t) ? [t.card.id] : [],
      ),
    );
    return findingOf(late.filter((p) => over.has(p.bankMessage?.cardId ?? '')).map((p) => p.id));
  }
}

function historyAudit(history: HistoryRescan) {
  return Object.fromEntries(
    Object.entries(history.sources).map(([source, s]) => [
      source,
      { state: s.state, reason: s.reason, fetched: s.fetched, recovered: s.recovered.length },
    ]),
  );
}
