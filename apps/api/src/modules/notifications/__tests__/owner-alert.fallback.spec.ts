import { ALERT_KINDS, FULFILLMENT_ALERT_KINDS, alertRef } from '@repo/shared';
import { ownerAlertFallbackText } from '../owner-alert.fallback';

// The last-attempt text without the database (audit L-3, re-review): what the refId says is filled
// in, only row data stays `?`. Synthetic ids only.
const NOW = new Date('2030-01-01T09:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('owner alert fallback text', () => {
  it.each([...ALERT_KINDS, ...FULFILLMENT_ALERT_KINDS])(
    '%s renders with no placeholder left',
    (kind) => {
      expect(ownerAlertFallbackText(kind, 'cmref1', NOW)).not.toMatch(/\{\w+\}/);
    },
  );

  it('listenerDown: the minutes from the outage start in the refId', () => {
    const ref = alertRef.listenerDown(minutesAgo(12), NOW);
    expect(ownerAlertFallbackText('listenerDown', ref, NOW)).toContain(' 12 daqiqadan');
  });

  it('listenerStopped, bankChatAnomaly, foreignChat: reason and bank from the refId', () => {
    const stopped = alertRef.listenerStopped('BANNED', NOW);
    expect(ownerAlertFallbackText('listenerStopped', stopped, NOW)).toContain('sabab: BANNED');
    const anomaly = alertRef.bankChatAnomaly('HUMO_BOT', 'OUTGOING', NOW);
    const text = ownerAlertFallbackText('bankChatAnomaly', anomaly, NOW);
    expect(text).toContain('HUMO boti');
    expect(text).toContain('(OUTGOING)');
    const foreign = alertRef.foreignChat('UZCARD_BOT', NOW);
    expect(ownerAlertFallbackText('foreignChat', foreign, NOW)).toContain('UZCARD bot');
  });

  it('a review alert keeps its review id; the card digits need a row and stay ?', () => {
    const text = ownerAlertFallbackText('chainBreak', 'cmreview1', NOW);
    expect(text).toContain('Ko‘rib chiqish: cmreview1');
    expect(text).toContain('***?');
  });

  it('message, audit and user ids, the silent hours and the reconcile day come from the refId', () => {
    expect(ownerAlertFallbackText('messageStuck', 'cmmsg1', NOW)).toContain('xabari cmmsg1');
    expect(ownerAlertFallbackText('adminAction', 'cmaudit1', NOW)).toContain('(cmaudit1)');
    const frozen = alertRef.walletFrozen('cmuser1', 'cmentry1');
    expect(ownerAlertFallbackText('walletFrozen', frozen, NOW)).toContain('cmuser1');
    expect(ownerAlertFallbackText('walletFrozen', frozen, NOW)).not.toContain('cmentry1');
    expect(ownerAlertFallbackText('reconcileFailed', '20300101', NOW)).toContain('20300101');
  });

  it('fulfillment: the order or transfer id, workerDown minutes, the queueStuck promise', () => {
    expect(ownerAlertFallbackText('held', 'cmorder1_cmattempt1', NOW)).toContain(
      'Buyurtma: cmorder1',
    );
    const down = alertRef.workerDown(minutesAgo(7));
    expect(ownerAlertFallbackText('workerDown', down, NOW)).toContain(' 7 daqiqadan');
    const stuck = ownerAlertFallbackText('queueStuck', `cmorder1_${String(NOW.getTime())}`, NOW);
    expect(stuck).toContain('5 daqiqadan');
    expect(stuck).toContain('#?');
  });

  it('a refId that does not parse leaves the gap as ?', () => {
    expect(ownerAlertFallbackText('listenerStopped', 'nonsense', NOW)).toContain('sabab: ?');
  });
});
