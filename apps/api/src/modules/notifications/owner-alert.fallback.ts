import {
  BANK_FEED_ALERT_PARAMS,
  BANK_OF_SOURCE,
  BankFeedAlertKindSchema,
  FULFILLMENT_ALERT_PARAMS,
  FulfillmentAlertKindSchema,
  QUEUE_STUCK_AFTER_MS,
  daytimeMinutesBetween,
  parseBankChatAnomalyRef,
  parseForeignChatAlertRef,
  parseListenerDownRef,
  parseListenerStoppedRef,
  parseWorkerDownRef,
  refIdSubject,
  type BankFeedAlertKind,
  type FulfillmentAlertKind,
  type OwnerAlertKind,
} from '@repo/shared';
import { translate } from '../../common/i18n/translate';

const OWNER_LOCALE = 'uz' as const;
const UNKNOWN = '?';
const EPOCH_SEC = /^\d{1,12}$/;

type Params = Record<string, string | number>;

/**
 * An owner alert's text WITHOUT reading the database (S6 audit L-3): whatever the refId itself
 * says is filled in (the review / message / audit id, the bank and reason of a bank-chat alert,
 * the minutes of an outage, the order or transfer id...), and only what needs a row stays `?`.
 * The notify consumer uses it on the LAST attempt of a job whose rows could not be read (database
 * down): the owner then hears that something happened, with gaps, instead of nothing, and the job
 * id is not added again for NOTIFY_DEDUPE_SEC. Same catalog key as the full text.
 *
 * Runbook (docs/07): such an alert may describe something already resolved by the time it is
 * read, because nothing could be checked against the database.
 */
export function ownerAlertFallbackText(alert: OwnerAlertKind, refId: string, now: Date): string {
  const bank = BankFeedAlertKindSchema.safeParse(alert);
  if (bank.success) {
    const known = bankParams(bank.data, refId, now);
    const params = BANK_FEED_ALERT_PARAMS[bank.data].map(
      (name) => [name, known[name] ?? UNKNOWN] as const,
    );
    return translate(OWNER_LOCALE, `alerts.bankFeed.${bank.data}`, Object.fromEntries(params));
  }
  const kind = FulfillmentAlertKindSchema.parse(alert);
  const known = fulfillmentParams(kind, refId, now);
  const params = FULFILLMENT_ALERT_PARAMS[kind].map(
    (name) => [name, known[name] ?? UNKNOWN] as const,
  );
  return translate(OWNER_LOCALE, `alerts.fulfillment.${kind}`, Object.fromEntries(params));
}

// What OwnerAlertRenderer reads from the refId alone (the same parsers), never from a row.
function bankParams(alert: BankFeedAlertKind, refId: string, now: Date): Params {
  const params: Params = {};
  // Review alerts are raised with the review id, message alerts with the message id.
  if (BANK_FEED_ALERT_PARAMS[alert].includes('reviewId')) params['reviewId'] = refId;
  if (BANK_FEED_ALERT_PARAMS[alert].includes('messageId')) params['messageId'] = refId;
  switch (alert) {
    case 'listenerDown': {
      const since = parseListenerDownRef(refId);
      if (since !== null) params['minutes'] = minutesBetween(since, now);
      break;
    }
    case 'listenerStopped': {
      const reason = parseListenerStoppedRef(refId);
      if (reason !== null) params['reason'] = reason;
      break;
    }
    case 'bankChatAnomaly': {
      const ref = parseBankChatAnomalyRef(refId);
      if (ref !== null)
        Object.assign(params, { bank: BANK_OF_SOURCE[ref.source], reason: ref.reason });
      break;
    }
    case 'foreignChat': {
      const source = parseForeignChatAlertRef(refId);
      if (source !== null) params['bank'] = BANK_OF_SOURCE[source];
      break;
    }
    case 'cardSilent': {
      const cardId = refIdSubject(refId);
      const since = refId.slice((cardId ?? '').length + 1);
      if (cardId !== null && EPOCH_SEC.test(since)) {
        const minutes = daytimeMinutesBetween(new Date(Number(since) * 1000), now);
        params['hours'] = Math.floor(minutes / 60);
      }
      break;
    }
    case 'reconcileFailed':
      if (/^\d{8}$/.test(refId)) params['day'] = refId;
      break;
    case 'walletFrozen': {
      const userId = refIdSubject(refId);
      if (userId !== null) params['userId'] = userId;
      break;
    }
    case 'adminAction':
      params['ref'] = refId;
      break;
    default:
      break;
  }
  return params;
}

function fulfillmentParams(alert: FulfillmentAlertKind, refId: string, now: Date): Params {
  // The order or transfer id (the order id of a composite `<orderId>_<suffix>` ref).
  const params: Params = { ref: refIdSubject(refId) ?? refId };
  if (alert === 'queueStuck') params['minutes'] = QUEUE_STUCK_AFTER_MS / 60_000;
  if (alert === 'workerDown') {
    const since = parseWorkerDownRef(refId);
    if (since !== null) params['minutes'] = minutesBetween(since, now);
  }
  return params;
}

function minutesBetween(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
}
