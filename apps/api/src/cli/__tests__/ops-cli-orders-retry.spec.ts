import { MAX_SEND_ATTEMPTS } from '@repo/shared';
import { OrderRetryService } from '../../modules/orders/admin/order-retry.service';
import { WHO, runFake as run } from './fake-cli';

// order:retry and the runner without a database (phase 5 S10 fix round, items 1, 6 and 10; S9b).

const ORDER = 'ckorder0000000000000000001';

describe('order:retry (no database)', () => {
  const done = (job: string, attemptsUsed: number | null = 0) => ({
    applied: true,
    orderId: ORDER,
    auditId: 'a1',
    job,
    adminAction: true,
    attemptsUsed,
  });
  const servicesFor = (retry: jest.Mock) =>
    new Map<unknown, unknown>([[OrderRetryService, { retry }]]);

  it('a queued job: jobQueued=true and no warning', async () => {
    const retry = jest.fn().mockResolvedValue(done('QUEUED'));
    const out = await run(['order:retry', ORDER, ...WHO], servicesFor(retry));
    expect(out.code).toBe(0);
    expect(out.out).toContain('jobQueued=true');
    expect(out.err).toEqual([]);
  });

  it('CR m4: the old job is still running: jobQueued=false and the operator is told to re-run', async () => {
    const retry = jest.fn().mockResolvedValue(done('RUNNING'));
    const out = await run(['order:retry', ORDER, ...WHO], servicesFor(retry));
    expect(out.code).toBe(0);
    expect(out.out).toContain('jobQueued=false');
    expect(out.err.join('\n')).toContain('still running');
    expect(out.err.join('\n')).toContain('run order:retry again');
  });

  it('S9b: a release after attempts proven not sent warns how many more it gives; the old flag is gone', async () => {
    const retry = jest.fn().mockResolvedValue(done('QUEUED', 2));
    const out = await run(['order:retry', ORDER, ...WHO], servicesFor(retry));
    expect(out.code).toBe(0);
    expect(out.out).toContain('applied=true');
    const err = out.err.join('\n');
    expect(err).toContain('2 send attempt(s) of this order were already proven NOT sent');
    expect(err).toContain(`at most ${String(MAX_SEND_ATTEMPTS)} more`);
    const flagged = await run(
      ['order:retry', ORDER, ...WHO, '--confirm-attempt-limit'],
      servicesFor(retry),
    );
    expect(flagged.code).toBe(2);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('no warning when nothing was used yet, nor for a re-run that wrote nothing', async () => {
    const none = await run(
      ['order:retry', ORDER, ...WHO],
      servicesFor(jest.fn().mockResolvedValue(done('QUEUED', 0))),
    );
    expect(none.err).toEqual([]);
    const rerun = jest
      .fn()
      .mockResolvedValue({ ...done('QUEUED', null), applied: false, auditId: null });
    const again = await run(['order:retry', ORDER, ...WHO], servicesFor(rerun));
    expect(again.code).toBe(0);
    expect(again.err).toEqual([]);
  });
});

describe('runner: an unexpected error (audit I-4)', () => {
  it('is printed on one terminal-safe line: no escape sequence, no second line', async () => {
    const retry = jest.fn().mockRejectedValue(new Error('row \u001b[2Jgone\nsecond line'));
    const services = new Map<unknown, unknown>([[OrderRetryService, { retry }]]);
    const out = await run(['order:retry', ORDER, ...WHO], services);
    expect(out.code).toBe(1);
    expect(out.err).toEqual(['failed: Error row \\u{1B}[2Jgone\\u{A}second line']);
  });
});
