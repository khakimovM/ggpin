import { notifyJobId, notifyJobSchema, refIdSubject } from '@repo/shared';
import { episodeRef } from '../guard-ref';

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
});
