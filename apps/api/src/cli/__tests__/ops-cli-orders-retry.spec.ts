import { validationError } from '../../common/admin/admin-input';
import {
  ATTEMPT_LIMIT_NOT_SUPPORTED,
  OrderRetryService,
} from '../../modules/orders/admin/order-retry.service';
import { WHO, runFake as run } from './fake-cli';

// order:retry and the runner without a database (phase 5 S10 fix round, items 1, 6 and 10).

const ORDER = 'ckorder0000000000000000001';

describe('order:retry (no database)', () => {
  const done = (job: string) => ({
    applied: true,
    orderId: ORDER,
    auditId: 'a1',
    job,
    adminAction: true,
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

  it('the attempt-limit refusal is explained (refund after HELD_MAX_AGE, S9); the old flag is gone', async () => {
    const retry = jest
      .fn()
      .mockRejectedValue(validationError('order', ATTEMPT_LIMIT_NOT_SUPPORTED));
    const out = await run(['order:retry', ORDER, ...WHO], servicesFor(retry));
    expect(out.code).toBe(1);
    const err = out.err.join('\n');
    expect(err).toContain('proven NOT sent');
    expect(err).toContain('HELD_MAX_AGE');
    expect(err).toContain('ATTEMPT_LIMIT_NOT_SUPPORTED');
    const flagged = await run(
      ['order:retry', ORDER, ...WHO, '--confirm-attempt-limit'],
      servicesFor(retry),
    );
    expect(flagged.code).toBe(2);
    expect(retry).toHaveBeenCalledTimes(1);
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
