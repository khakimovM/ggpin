import { ORDER_STATUSES, notifyJobSchema, refIdSubject, type OrderStatus } from '@repo/shared';
import { OTHER_TRANSFER_ALERT_STATUSES, otherTransferLateNotices } from '../ton-notices';

// S9i (S9f SA N-1, review R6): an OTHER_TRANSFER mark is the owner's `tonLateConfirmed`
// `<T1>_<auditId>` only while the order is settled (delivered, failed, refunded, cancelled): no
// guard can stop on the mark any more. While the order is open (in review, held, paid, queued,
// processing) its guards stop on the mark, and there is no extra alert.

const T1 = 'cmh1transfer000000000001';
const AUDIT = 'cmh1auditotherrefund0001';
const SETTLED: readonly OrderStatus[] = ['DELIVERED', 'FAILED', 'REFUNDED', 'CANCELLED'];

describe('otherTransferLateNotices (S9i N-1, R6)', () => {
  it('the settled states are exactly delivered, failed, refunded and cancelled', () => {
    expect([...OTHER_TRANSFER_ALERT_STATUSES].sort()).toEqual([...SETTLED].sort());
  });

  it.each(ORDER_STATUSES.map((status) => [status, SETTLED.includes(status)] as const))(
    '%s: alert %s',
    (status, alerted) => {
      const notices = otherTransferLateNotices(status, T1, AUDIT);
      expect(notices).toEqual(
        alerted ? [{ kind: 'ALERT', alert: 'tonLateConfirmed', refId: `${T1}_${AUDIT}` }] : [],
      );
    },
  );

  it('DELIVERED: a valid notify job, read back as the marked transfer', () => {
    const [notice] = otherTransferLateNotices('DELIVERED', T1, AUDIT);
    if (notice?.kind !== 'ALERT') throw new Error('no alert');
    const job = { kind: 'OWNER_ALERT', alert: notice.alert, refId: notice.refId };
    expect(notifyJobSchema.safeParse(job).success).toBe(true);
    expect(refIdSubject(notice.refId)).toBe(T1);
  });

  it('none in review, held or without an order', () => {
    expect(otherTransferLateNotices('NEEDS_REVIEW', T1, AUDIT)).toEqual([]);
    expect(otherTransferLateNotices('HELD', T1, AUDIT)).toEqual([]);
    expect(otherTransferLateNotices(null, T1, AUDIT)).toEqual([]);
  });
});
