import { notifyJobId, notifyJobSchema, refIdSubject } from '@repo/shared';
import { abandonedAlertRef } from '../../../fulfillment/fulfill-settle';
import {
  WALLET_BLOCKED_REMIND_EVERY_MS,
  episodeAlert,
  episodeRef,
  walletBlockedRef,
} from '../guard-ref';

// Plan §12: the `reconcileGuardRefused` refId carries an episode (the hour of the database clock),
// so a second refusal of the same order is not swallowed by the 30-day notify dedupe, and it
// stays a valid id segment (IdSegmentSchema: [A-Za-z0-9_]{1,64}) the renderer reads back.

const ORDER = 'cmh1orderid0000000000001'; // a cuid2 id: 24 characters
const AT = Date.parse('2026-11-16T10:20:00.000Z');
const HOUR = 3_600_000;

function job(refId: string) {
  return notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert: 'reconcileGuardRefused', refId });
}

describe('episodeRef', () => {
  it('is <orderId>_<scope>_<hour> and the renderer reads the order back', () => {
    const ref = episodeRef(ORDER, 'review', AT);
    expect(ref).toBe(`${ORDER}_review_${String(Math.floor(AT / HOUR))}`);
    expect(ref === null ? null : refIdSubject(ref)).toBe(ORDER);
    expect(episodeRef(ORDER, 'ton', AT)).toBe(`${ORDER}_ton_${String(Math.floor(AT / HOUR))}`);
  });

  it('a CONSUMED_UNMATCHED reminder (I-2): <transferId>_cu_<hour>, read back as the transfer', () => {
    const transferId = 'cmh1transfer000000000001';
    const ref = episodeRef(transferId, 'cu', AT);
    expect(ref).toBe(`${transferId}_cu_${String(Math.floor(AT / HOUR))}`);
    if (ref === null) throw new Error('no ref');
    expect(refIdSubject(ref)).toBe(transferId);
    const reminder = { kind: 'OWNER_ALERT', alert: 'tonConsumedUnmatched', refId: ref } as const;
    expect(notifyJobSchema.safeParse(reminder).success).toBe(true);
    const nextHour = episodeRef(transferId, 'cu', AT + HOUR);
    expect(nextHour).not.toBe(ref);
  });

  it('a stuck order lease (S9d, Q-17): <orderId>_lock_<hour> on needsReview, never the plain id', () => {
    const ref = episodeRef(ORDER, 'lock', AT);
    expect(ref).toBe(`${ORDER}_lock_${String(Math.floor(AT / HOUR))}`);
    if (ref === null) throw new Error('no ref');
    expect(refIdSubject(ref)).toBe(ORDER);
    const alert = { kind: 'OWNER_ALERT', alert: 'needsReview', refId: ref } as const;
    expect(notifyJobSchema.safeParse(alert).success).toBe(true);
    expect(ref).not.toBe(ORDER);
  });

  it('is the same within an hour and a new alert id in the next one (mutant: no episode)', () => {
    const first = episodeRef(ORDER, 'review', AT);
    const sameHour = episodeRef(ORDER, 'review', AT + 30 * 60_000);
    const nextHour = episodeRef(ORDER, 'review', AT + HOUR);
    if (first === null || sameHour === null || nextHour === null) throw new Error('no ref');
    expect(notifyJobId(job(sameHour))).toBe(notifyJobId(job(first)));
    expect(notifyJobId(job(nextHour))).not.toBe(notifyJobId(job(first)));
  });

  it('stays within the 64-character id segment for the longest id it accepts', () => {
    const longest = 'a'.repeat(40);
    const farFuture = Date.parse('9999-12-31T23:00:00.000Z');
    const ref = episodeRef(longest, 'review', farFuture);
    expect(ref).not.toBeNull();
    expect(ref?.length).toBeLessThanOrEqual(64);
    expect(
      notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'reconcileGuardRefused', refId: ref })
        .success,
    ).toBe(true);
  });

  it('refuses an id that cannot be part of an alert id (fail closed: logged, never sent)', () => {
    expect(episodeRef('a'.repeat(41), 'review', AT)).toBeNull();
    expect(episodeRef('order_with_underscore', 'review', AT)).toBeNull();
    expect(episodeRef('order-with-dash', 'review', AT)).toBeNull();
    expect(episodeRef('', 'review', AT)).toBeNull();
    expect(episodeRef(ORDER, 'review', Number.NaN)).toBeNull();
    expect(episodeRef(ORDER, 'review', -1)).toBeNull();
  });

  it('S9e held: <orderId>_held_<hour> on reconcileGuardRefused, the order read back', () => {
    const ref = episodeRef(ORDER, 'held', AT);
    expect(ref).toBe(`${ORDER}_held_${String(Math.floor(AT / HOUR))}`);
    if (ref === null) throw new Error('no ref');
    expect(refIdSubject(ref)).toBe(ORDER);
    expect(episodeAlert('held')).toBe('reconcileGuardRefused');
    expect(ref).not.toBe(episodeRef(ORDER, 'review', AT));
    // The scopes S9d added keep their alert and period.
    expect(episodeAlert('abandoned')).toBe('needsReview');
    expect(episodeRef(ORDER, 'abandoned', AT)).toBe(
      `${ORDER}_abandoned_${String(Math.floor(AT / (24 * HOUR)))}`,
    );
  });

  it('S9f heldlate: <orderId>_heldlate_<day>, one id for the whole day, a new one the next day', () => {
    const day = Math.floor(AT / (24 * HOUR));
    const ref = episodeRef(ORDER, 'heldlate', AT);
    expect(ref).toBe(`${ORDER}_heldlate_${String(day)}`);
    if (ref === null) throw new Error('no ref');
    expect(refIdSubject(ref)).toBe(ORDER);
    expect(episodeAlert('heldlate')).toBe('reconcileGuardRefused');
    expect(job(ref).refId).toBe(ref);
    const dayStart = day * 24 * HOUR;
    expect(episodeRef(ORDER, 'heldlate', dayStart)).toBe(ref);
    expect(episodeRef(ORDER, 'heldlate', dayStart + 24 * HOUR - 1)).toBe(ref);
    expect(episodeRef(ORDER, 'heldlate', dayStart + 24 * HOUR)).toBe(
      `${ORDER}_heldlate_${String(day + 1)}`,
    );
    // The other HELD refusals keep their hour.
    expect(episodeRef(ORDER, 'held', AT + HOUR)).not.toBe(episodeRef(ORDER, 'held', AT));
  });

  it('S9f heldlive (owner 2026-11-18): <orderId>_heldlive_<day>, daily like heldlate', () => {
    const day = Math.floor(AT / (24 * HOUR));
    const ref = episodeRef(ORDER, 'heldlive', AT);
    expect(ref).toBe(`${ORDER}_heldlive_${String(day)}`);
    if (ref === null) throw new Error('no ref');
    expect(refIdSubject(ref)).toBe(ORDER);
    expect(episodeAlert('heldlive')).toBe('reconcileGuardRefused');
    expect(job(ref).refId).toBe(ref);
    const dayStart = day * 24 * HOUR;
    expect(episodeRef(ORDER, 'heldlive', dayStart + 24 * HOUR - 1)).toBe(ref);
    expect(episodeRef(ORDER, 'heldlive', dayStart + 24 * HOUR)).toBe(
      `${ORDER}_heldlive_${String(day + 1)}`,
    );
    expect(ref).not.toBe(episodeRef(ORDER, 'heldlate', AT));
  });
});

describe('walletBlockedRef (S9e, CR F6)', () => {
  const transferId = 'cmh1transfer000000000001';
  const six = 6 * HOUR;
  const blocked = Date.parse('2026-11-17T05:59:30.000Z');

  it('<transferId>_wb_<n>: whole 6-hour periods since the block, none in the first', () => {
    expect(WALLET_BLOCKED_REMIND_EVERY_MS).toBe(six);
    expect(walletBlockedRef(transferId, blocked, blocked)).toBeNull();
    // The epoch bucket turns at 06:00, 30 s after the block: no reminder then.
    expect(walletBlockedRef(transferId, blocked, blocked + 31_000)).toBeNull();
    expect(walletBlockedRef(transferId, blocked, blocked + six - 1)).toBeNull();
    expect(walletBlockedRef(transferId, blocked, blocked + six)).toBe(`${transferId}_wb_1`);
    expect(walletBlockedRef(transferId, blocked, blocked + 2 * six - 1)).toBe(`${transferId}_wb_1`);
    expect(walletBlockedRef(transferId, blocked, blocked + 2 * six)).toBe(`${transferId}_wb_2`);
  });

  it('a valid tonWalletBlocked id, read back as the transfer, never the plain id', () => {
    const ref = walletBlockedRef(transferId, blocked, blocked + 500 * six);
    if (ref === null) throw new Error('no ref');
    expect(ref).not.toBe(transferId);
    expect(refIdSubject(ref)).toBe(transferId);
    expect(episodeAlert('wb')).toBe('tonWalletBlocked');
    const reminder = { kind: 'OWNER_ALERT', alert: 'tonWalletBlocked', refId: ref } as const;
    expect(notifyJobSchema.safeParse(reminder).success).toBe(true);
    const longest = walletBlockedRef('a'.repeat(40), 0, 9_999 * 365 * 24 * HOUR);
    expect(longest?.length).toBeLessThanOrEqual(64);
  });

  it('refuses what could not be an alert id or a clock it cannot read', () => {
    expect(walletBlockedRef('not_an_id', blocked, blocked + six)).toBeNull();
    expect(walletBlockedRef('x'.repeat(41), blocked, blocked + six)).toBeNull();
    expect(walletBlockedRef(transferId, Number.NaN, blocked + six)).toBeNull();
    expect(walletBlockedRef(transferId, blocked, Number.NaN)).toBeNull();
  });
});

describe('the settle and the reconciler name a used-up order alike (S9d re-review R1)', () => {
  it('one day, one notify job id: the settle and the stale step are deduped into one alert', () => {
    const day = 24 * HOUR;
    for (const at of [AT, AT - (AT % day), AT - (AT % day) + day - 1]) {
      const reconciler = episodeRef(ORDER, 'abandoned', at);
      expect(abandonedAlertRef(ORDER, at)).toBe(reconciler);
      const asJob = (refId: string) =>
        notifyJobId(notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert: 'needsReview', refId }));
      expect(asJob(abandonedAlertRef(ORDER, at))).toBe(asJob(reconciler ?? ''));
    }
    expect(abandonedAlertRef(ORDER, AT + day)).not.toBe(abandonedAlertRef(ORDER, AT));
    // An id no episode can carry keeps the old composite ref (the alert is never dropped).
    expect(abandonedAlertRef('x'.repeat(41), AT)).toBe(`${'x'.repeat(41)}_abandoned`);
  });
});
