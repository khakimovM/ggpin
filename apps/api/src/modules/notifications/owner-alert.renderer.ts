import { Inject, Injectable } from '@nestjs/common';
import {
  BANK_FEED_ALERT_PARAMS,
  BANK_OF_SOURCE,
  daytimeMinutesBetween,
  formatMoney,
  parseCardLimitAlertRef,
  parseCardReservedHighRef,
  parseForeignChatAlertRef,
  BANK_FEED_SOURCES,
  RECONCILE_HISTORY_REASONS,
  RECONCILE_HISTORY_STATES,
  RECONCILE_MISMATCH_CODES,
  receivedUsagePercent,
  refIdSubject,
  reservedSharePercent,
  type BankFeedAlertKind,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { translate, type TranslateParams } from '../../common/i18n/translate';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { NotifySourcesRepository } from './notify-sources.repository';

/** The alert's source row is gone or does not fit: the job cannot be rendered (never retried). */
export class AlertSourceMissingError extends Error {
  constructor(
    readonly alert: BankFeedAlertKind,
    readonly refId: string,
  ) {
    super(`alert ${alert} ${refId}: source row missing`);
    this.name = 'AlertSourceMissingError';
  }
}

type Params = Record<string, string | number>;

const OWNER_LOCALE = 'uz' as const;
const EPOCH = /^\d{1,12}$/;
const WHOLE = /^\d{1,9}$/;

/** "12 550 so‘m": the bare number from formatMoney, the unit from i18n (never hardcoded). */
export function moneyText(amountTiyin: bigint, locale: 'uz' | 'ru'): string {
  return translate(locale, 'common.money.uzs', { amount: formatMoney(amountTiyin, locale) });
}

/**
 * Owner alerts (`notify` OWNER_ALERT): always Uzbek (the owner's language), parameters read from
 * the database by `refId` exactly as docs/05 "Ogohlantirishlar jadvali" lists them. Ids, codes,
 * last4 and amounts only: never a full card number, balance or message text. `translate`
 * HTML-escapes every parameter (the channel and reason texts come from bank messages).
 */
@Injectable()
export class OwnerAlertRenderer {
  constructor(
    private readonly sources: NotifySourcesRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async render(alert: BankFeedAlertKind, refId: string): Promise<string> {
    const params = await this.params(alert, refId);
    if (params === null) throw new AlertSourceMissingError(alert, refId);
    // Exactly the declared placeholders (a test in packages/i18n holds the texts to the same list).
    const declared: TranslateParams = Object.fromEntries(
      BANK_FEED_ALERT_PARAMS[alert].map((name) => [name, params[name] ?? '']),
    );
    return translate(OWNER_LOCALE, `alerts.bankFeed.${alert}`, declared);
  }

  private async params(alert: BankFeedAlertKind, refId: string): Promise<Params | null> {
    switch (alert) {
      case 'unrecognized':
      case 'titleUnknown':
      case 'integrityAnomaly':
      case 'processingFailed':
      case 'amountReallocated':
      case 'lateStored':
      case 'manualCreditSeen':
      case 'cardUnknown':
      case 'timeSkew':
      case 'rejected':
      case 'cardRetired':
      case 'chainBreak':
      case 'autoCreditPaused':
      case 'noMatch':
      case 'ambiguous':
      case 'duplicate':
      case 'cancelledLate':
      case 'userBlocked':
      case 'dailyLimit':
      case 'possibleReversal':
        return this.reviewParams(alert, refId);
      case 'edited':
      case 'messageStuck':
      case 'effectsFailed':
        return { messageId: refId };
      case 'limitCheckFailed': {
        const message = await this.sources.message(refId);
        const card = message?.cardId == null ? null : await this.cardParams(message.cardId);
        return card === null ? null : { ...card, messageId: refId };
      }
      case 'debit': {
        const message = await this.sources.message(refId);
        if (message?.amountTiyin == null || message.last4 === null) return null;
        return { last4: message.last4, amount: moneyText(message.amountTiyin, OWNER_LOCALE) };
      }
      case 'cardVerified':
      case 'cardDraining':
      case 'cardDrained':
        return this.cardParams(refId);
      case 'cardFull': {
        const ref = parseCardLimitAlertRef('cardFull', refId);
        return ref === null ? null : this.cardParams(ref.cardId);
      }
      case 'cardNearLimit':
      case 'cardReservedHigh':
        return this.percentParams(alert, refId);
      case 'cardSilent':
        return this.silentParams(refId);
      case 'lateOverLimit':
        return this.lateParams(refId);
      case 'listenerDown':
        return this.listenerParams();
      case 'sessionRevoked':
      case 'newAuthorization':
        return {};
      case 'reconcileOk':
      case 'reconcileMismatch':
        return this.reconcileParams(refId);
      case 'foreignChat': {
        const source = parseForeignChatAlertRef(refId);
        return source === null ? null : { bank: BANK_OF_SOURCE[source] };
      }
      // Sent when the run itself failed: nothing to read, the refId is the Tashkent day.
      case 'reconcileFailed':
        return /^\d{8}$/.test(refId) ? { day: refId } : null;
      case 'walletFrozen': {
        const userId = refIdSubject(refId);
        return userId === null ? null : { userId };
      }
      case 'adminAction': {
        const audit = await this.sources.auditLog(refId);
        return audit === null ? null : { action: audit.action, ref: audit.id };
      }
    }
  }

  private async reviewParams(alert: BankFeedAlertKind, reviewId: string): Promise<Params | null> {
    const review = await this.sources.review(reviewId);
    if (review === null) return null;
    const message = review.bankMessage;
    // integrityAnomaly: the reason is the check that failed (SENDER_MISMATCH / TEXT_HASH_MISMATCH).
    const reason = alert === 'integrityAnomaly' ? review.note : message.rejectReason;
    const params: Params = { reviewId: review.id, reason: reason ?? '' };
    const last4 = review.card?.last4 ?? message.last4;
    if (last4 !== null) params['last4'] = last4;
    // The card the money reached (titleUnknown always has one: it matched a request on it; the
    // card-specific alerts below are only raised for a message on a card, reviewAlertOf).
    if (review.card !== null) params['bank'] = review.card.bank;
    if (message.amountTiyin !== null)
      params['amount'] = moneyText(message.amountTiyin, OWNER_LOCALE);
    if (alert === 'dailyLimit') {
      const reason = review.note === 'NEW_ACCOUNT_DAILY_LIMIT' ? review.note : 'DAILY_LIMIT';
      const cap =
        reason === 'DAILY_LIMIT'
          ? this.config.TOPUP_DAILY_MAX_TIYIN
          : this.config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN;
      params['limit'] = translate(OWNER_LOCALE, `alerts.limitReason.${reason}`, {
        cap: moneyText(cap, OWNER_LOCALE),
      });
    }
    const missing = BANK_FEED_ALERT_PARAMS[alert].some((name) => params[name] === undefined);
    return missing ? null : params;
  }

  private async cardParams(cardId: string): Promise<Params | null> {
    const card = await this.sources.card(cardId);
    return card === null ? null : { bank: card.bank, last4: card.last4 };
  }

  /**
   * `percent` is computed again from the database now (never carried in the job): the held
   * share for cardReservedHigh, the RECEIVED share for cardNearLimit (D-45).
   */
  private async percentParams(alert: BankFeedAlertKind, refId: string): Promise<Params | null> {
    const cardId =
      alert === 'cardReservedHigh'
        ? (parseCardReservedHighRef(refId)?.cardId ?? null)
        : (parseCardLimitAlertRef('cardNearLimit', refId)?.cardId ?? null);
    if (cardId === null) return null;
    const holdSec = this.config.TOPUP_CAPACITY_HOLD_SEC;
    const totals = await this.sources.cardTotals(cardId, this.clock.now(), holdSec);
    if (totals === null) return null;
    const percent =
      alert === 'cardReservedHigh' ? reservedSharePercent(totals) : receivedUsagePercent(totals);
    return { bank: totals.card.bank, last4: totals.card.last4, percent };
  }

  /** `<cardId>_<last CREDIT, epoch seconds>`: hours = daytime hours silent until now. */
  private async silentParams(refId: string): Promise<Params | null> {
    const cardId = refIdSubject(refId);
    const since = refId.slice((cardId ?? '').length + 1);
    if (cardId === null || !EPOCH.test(since)) return null;
    const card = await this.sources.card(cardId);
    if (card === null) return null;
    const minutes = daytimeMinutesBetween(new Date(Number(since) * 1000), this.clock.now());
    return { bank: card.bank, last4: card.last4, hours: Math.floor(minutes / 60) };
  }

  private async lateParams(paymentId: string): Promise<Params | null> {
    const payment = await this.sources.payment(paymentId);
    const card = payment?.bankMessage?.card ?? null;
    if (payment === null || card === null) return null;
    return {
      bank: card.bank,
      last4: card.last4,
      amount: moneyText(payment.amountTiyin, OWNER_LOCALE),
    };
  }

  /** Minutes since the last heartbeat; "?" when there is none (the listener never ran). */
  private async listenerParams(): Promise<Params> {
    const raw = await this.sources.heartbeat();
    if (raw === null || !/^\d{1,15}$/.test(raw)) return { minutes: '?' };
    const minutes = Math.max(0, Math.floor((this.clock.now().getTime() - Number(raw)) / 60_000));
    return { minutes };
  }

  // The latest run of the day (docs/05 §10): whole numbers, a known history state and the
  // non-zero mismatch codes, in RECONCILE_MISMATCH_CODES order. Anything else: not renderable.
  private async reconcileParams(day: string): Promise<Params | null> {
    const run = await this.sources.reconcileRun(day);
    const after: unknown = run?.after;
    if (typeof after !== 'object' || after === null) return null;
    const field = (name: string): unknown => (name in after ? Reflect.get(after, name) : undefined);
    const count = String(field('count'));
    const debits = String(field('debits'));
    const openReviews = String(field('openReviews'));
    const history = field('historyScan');
    const mismatches = field('mismatches');
    if (![count, debits, openReviews].every((n) => WHOLE.test(n))) return null;
    if (!RECONCILE_HISTORY_STATES.some((state) => state === history)) return null;
    if (typeof mismatches !== 'object' || mismatches === null) return null;
    const details: string[] = [];
    for (const code of RECONCILE_MISMATCH_CODES) {
      const n = String(Reflect.get(mismatches, code) ?? 0);
      if (!WHOLE.test(n)) return null;
      if (n !== '0') details.push(`${code}=${n}`);
    }
    // L-1: why each source's re-scan was not ok (older rows have none).
    details.push(...historyReasons(field('history')));
    return {
      count,
      debits,
      openReviews,
      history: translate(OWNER_LOCALE, `alerts.reconcileHistory.${String(history)}`),
      details: details.length === 0 ? '-' : details.join(', '),
    };
  }
}

/**
 * `<source>=<reason>` per source whose re-scan has a reason. An unknown code (a worker deployed
 * before this API) is `<source>=?`: never the raw value, and never a lost mismatch alert.
 */
function historyReasons(history: unknown): string[] {
  if (typeof history !== 'object' || history === null) return [];
  const out: string[] = [];
  for (const source of BANK_FEED_SOURCES) {
    const entry: unknown = Reflect.get(history, source);
    const reason: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'reason') : undefined;
    if (reason === undefined || reason === null) continue;
    const known = RECONCILE_HISTORY_REASONS.find((code) => code === reason);
    out.push(`${source}=${known ?? '?'}`);
  }
  return out;
}
