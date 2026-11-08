import { tashkentDayKey } from '@repo/shared';
import type { BankFeedNotifier } from '../../bank-feed/bank-feed-notifier';
import { PaymentReconcileProcessor } from '../payment-reconcile.processor';
import type { PaymentReconcileService, ReconcileReport } from '../payment-reconcile.service';

// S9 M2: a reconciliation that fails every attempt is never silent. Plain fakes: no DB, no Redis.
function setup(run: () => Promise<ReconcileReport>, alertFails = false) {
  const alert = jest.fn<Promise<void>, Parameters<BankFeedNotifier['alert']>>(() =>
    alertFails ? Promise.reject(new Error('redis down')) : Promise.resolve(),
  );
  const reconcile: Pick<PaymentReconcileService, 'run'> = { run };
  const notifier: Pick<BankFeedNotifier, 'alert'> = { alert };
  const processor = new PaymentReconcileProcessor(
    reconcile as PaymentReconcileService,
    notifier as BankFeedNotifier,
  );
  const logError = jest.fn<void, [string]>();
  processor['logger'].log = jest.fn();
  processor['logger'].warn = jest.fn();
  processor['logger'].error = logError;
  return { processor, alert, logError };
}

const job = (attemptsMade: number) => ({
  id: 'payment-reconcile:daily',
  attemptsMade,
  opts: { attempts: 3 },
});

class SyntheticDbError extends Error {
  constructor() {
    super('synthetic: database said no');
    this.name = 'SyntheticDbError';
  }
}

describe('PaymentReconcileProcessor', () => {
  it('an early failed attempt only rethrows (BullMQ retries it); no alert yet', async () => {
    const { processor, alert } = setup(() => Promise.reject(new SyntheticDbError()));
    await expect(processor.process(job(0))).rejects.toBeInstanceOf(SyntheticDbError);
    await expect(processor.process(job(1))).rejects.toBeInstanceOf(SyntheticDbError);
    expect(alert).not.toHaveBeenCalled();
  });

  it('the LAST failed attempt alerts reconcileFailed for the Tashkent day, then rethrows', async () => {
    const { processor, alert, logError } = setup(() => Promise.reject(new SyntheticDbError()));
    const before = tashkentDayKey(new Date());
    await expect(processor.process(job(2))).rejects.toBeInstanceOf(SyntheticDbError);
    const after = tashkentDayKey(new Date());
    expect(alert).toHaveBeenCalledTimes(1);
    const [kind, day] = alert.mock.calls[0] ?? [];
    expect(kind).toBe('reconcileFailed');
    expect([before, after]).toContain(day);
    // The error NAME only, never its message.
    expect(logError.mock.calls.flat().join(' ')).not.toContain('database said no');
    expect(logError.mock.calls.flat().join(' ')).toContain('SyntheticDbError');
  });

  it('an alert that fails too is logged; the job still fails with the original error', async () => {
    const { processor, logError } = setup(() => Promise.reject(new SyntheticDbError()), true);
    await expect(processor.process(job(2))).rejects.toBeInstanceOf(SyntheticDbError);
    expect(logError.mock.calls.flat().join(' ')).toContain('owner alert failed too');
  });

  it('a successful run alerts nothing itself (the service sent ok / mismatch)', async () => {
    const report: ReconcileReport = {
      day: '20300504',
      auditId: 'cm3audit01',
      ok: true,
      history: {
        state: 'ok',
        sources: {
          HUMO_BOT: { state: 'ok', reason: null, fetched: 0, recovered: [] },
          UZCARD_BOT: { state: 'ok', reason: null, fetched: 0, recovered: [] },
        },
      },
      mismatches: {
        recovered: { count: 0, ids: [] },
        missingOutcome: { count: 0, ids: [] },
        creditUnaccounted: { count: 0, ids: [] },
        paymentWithoutMessage: { count: 0, ids: [] },
        chainBreak: { count: 0, ids: [] },
        pendingPastGrace: { count: 0, ids: [] },
        lateOverLimit: { count: 0, ids: [] },
        reviewOpenOver24h: { count: 0, ids: [] },
      },
      checkedMessages: 0,
      debits: 0,
      openReviews: 0,
      chainBreaksReviewed: 0,
    };
    const { processor, alert } = setup(() => Promise.resolve(report));
    await expect(processor.process(job(2))).resolves.toEqual({
      day: '20300504',
      auditId: 'cm3audit01',
      ok: true,
    });
    expect(alert).not.toHaveBeenCalled();
  });
});
