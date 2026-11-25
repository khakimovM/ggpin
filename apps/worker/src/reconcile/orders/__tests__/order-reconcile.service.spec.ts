import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { OrderReconcileProcessor } from '../order-reconcile.processor';
import type { OrderReconcileRepository } from '../order-reconcile.repository';
import { OrderReconcileService } from '../order-reconcile.service';
import {
  StepTally,
  describeReport,
  type ReconcileContext,
  type ReconcileStep,
} from '../reconcile-step';

// D-64 (1): one tick runs every step in the given order on ONE database clock reading; a step that
// throws is logged and the next one still runs. The processor is thin: `orders` only.

const NOW = 1_790_000_000_000;

function repository(): Pick<OrderReconcileRepository, 'databaseNowMs'> {
  return { databaseNowMs: jest.fn().mockResolvedValue(NOW) };
}

function step(name: string, seen: string[], fail = false): ReconcileStep {
  return {
    name,
    run: (context: ReconcileContext) => {
      seen.push(`${name}@${String(context.nowMs)}`);
      if (fail) return Promise.reject(new Error(`${name} broke`));
      const tally = new StepTally(name);
      tally.add('checked');
      tally.add('delivered', `order_${name}`);
      return Promise.resolve(tally.report());
    },
  };
}

describe('OrderReconcileService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs the steps in their fixed order on one database clock reading', async () => {
    const seen: string[] = [];
    const service = new OrderReconcileService(repository() as OrderReconcileRepository, [
      step('transfers', seen),
      step('review', seen),
    ]);
    const report = await service.tick();
    expect(seen).toEqual([`transfers@${String(NOW)}`, `review@${String(NOW)}`]);
    expect(report.failed).toEqual([]);
    expect(report.steps.map((s) => s.step)).toEqual(['transfers', 'review']);
  });

  it('goes on after a step that throws, and names it', async () => {
    const seen: string[] = [];
    const service = new OrderReconcileService(repository() as OrderReconcileRepository, [
      step('transfers', seen, true),
      step('review', seen),
    ]);
    const report = await service.tick();
    expect(seen).toEqual([`transfers@${String(NOW)}`, `review@${String(NOW)}`]);
    expect(report.failed).toEqual(['transfers']);
    expect(report.steps.map((s) => s.step)).toEqual(['review']);
  });

  it('logs counts and ids only', () => {
    const tally = new StepTally('review');
    tally.add('skip:NOT_PROVABLE');
    tally.add('refunded', 'order1');
    tally.add('busy');
    expect(describeReport(tally.report())).toBe(
      'step=review busy=1 refunded=1 skip:NOT_PROVABLE=1 [order1]',
    );
    expect(describeReport(new StepTally('transfers').report())).toBe('step=transfers idle');
  });
});

describe('OrderReconcileProcessor', () => {
  it('runs one tick for `orders` and returns the counts per step', async () => {
    const seen: string[] = [];
    const service = new OrderReconcileService(repository() as OrderReconcileRepository, [
      step('transfers', seen),
    ]);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const processor = new OrderReconcileProcessor(service);
    await expect(processor.process({ id: '1', name: 'orders' })).resolves.toEqual({
      steps: { transfers: { checked: 1, delivered: 1 } },
      failed: [],
    });
    jest.restoreAllMocks();
  });

  it('fails an unknown job name at once, without spending a retry', async () => {
    const tick = jest.fn();
    const processor = new OrderReconcileProcessor({ tick } as unknown as OrderReconcileService);
    await expect(processor.process({ id: '2', name: 'sweep' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(tick).not.toHaveBeenCalled();
  });
});
