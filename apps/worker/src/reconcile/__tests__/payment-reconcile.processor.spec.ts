import { tashkentDayKey } from '@repo/shared';
import { UnrecoverableError } from 'bullmq';
import type { BankFeedNotifier } from '../../bank-feed/bank-feed-notifier';
import type { BankTextPurgeResult, BankTextPurgeService } from '../bank-text-purge.service';
import { PaymentReconcileProcessor } from '../payment-reconcile.processor';
import type { PaymentReconcileService, ReconcileReport } from '../payment-reconcile.service';

// S9 M2: a reconciliation that fails every attempt is never silent. Plain fakes: no DB, no Redis.
function setup(
  run: () => Promise<ReconcileReport>,
  alertFails = false,
  purgeRun: () => Promise<BankTextPurgeResult> = () =>
    Promise.resolve({ purged: 0, batches: 1, more: false }),
) {
  const alert = jest.fn<Promise<void>, Parameters<BankFeedNotifier['alert']>>(() =>
    alertFails ? Promise.reject(new Error('redis down')) : Promise.resolve(),
  );
  const reconcile: Pick<PaymentReconcileService, 'run'> = { run };
  const notifier: Pick<BankFeedNotifier, 'alert'> = { alert };
  const purge: Pick<BankTextPurgeService, 'run'> = { run: jest.fn(purgeRun) };
  const processor = new PaymentReconcileProcessor(
    reconcile as PaymentReconcileService,
    notifier as BankFeedNotifier,
    purge as BankTextPurgeService,
  );
  const logError = jest.fn<void, [string]>();
  processor['logger'].log = jest.fn();
  processor['logger'].warn = jest.fn();
  processor['logger'].error = logError;
  return { processor, alert, logError, purge, reconcile };
}

const job = (attemptsMade: number, name = 'daily') => ({
  id: `payment-reconcile:${name}`,
  name,
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
        purgeOverdue: { count: 0, ids: [] },
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

  it('bank-text-purge runs the purge only (no reconciliation) and logs counts only', async () => {
    const reconcileRun = jest.fn(() => Promise.reject(new SyntheticDbError()));
    const { processor, alert, purge } = setup(reconcileRun, false, () =>
      Promise.resolve({ purged: 3, batches: 1, more: false }),
    );
    const log = jest.fn<void, [string]>();
    processor['logger'].log = log;
    await expect(processor.process(job(0, 'bank-text-purge'))).resolves.toEqual({
      purged: 3,
      batches: 1,
      more: false,
    });
    expect(purge.run).toHaveBeenCalledTimes(1);
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toBe('bank-text-purge purged=3 batches=1 more=false');
    expect(alert).not.toHaveBeenCalled();
  });

  it('a failed purge rethrows (BullMQ retries; idempotent), never alerts reconcileFailed', async () => {
    const { processor, alert } = setup(
      () => Promise.reject(new SyntheticDbError()),
      false,
      () => Promise.reject(new SyntheticDbError()),
    );
    await expect(processor.process(job(2, 'bank-text-purge'))).rejects.toBeInstanceOf(
      SyntheticDbError,
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('an unknown job name is refused and runs nothing', async () => {
    const reconcileRun = jest.fn(() => Promise.reject(new SyntheticDbError()));
    const { processor, purge } = setup(reconcileRun);
    const refused = processor.process(job(0, 'other'));
    await expect(refused).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(refused).rejects.toThrow('unknown payment-reconcile');
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(purge.run).not.toHaveBeenCalled();
  });
});
