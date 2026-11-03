import { Logger } from '@nestjs/common';
import { PRICE_SYNC_EVERY_MS } from '@repo/shared';
import { FakeQueue } from '../../__tests__/fake-infra';
import { PriceSyncScheduler } from '../price-sync.scheduler';

describe('PriceSyncScheduler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('upserts fx and cost with PRICE_SYNC_EVERY_MS under fixed ids', async () => {
    const queue = new FakeQueue();
    const scheduler = new PriceSyncScheduler(queue);
    scheduler.onApplicationBootstrap();
    await scheduler.whenScheduled();

    expect(queue.upsertJobScheduler.mock.calls).toEqual([
      ['price-sync:fx', { every: PRICE_SYNC_EVERY_MS }, { name: 'fx', data: {} }],
      ['price-sync:cost', { every: PRICE_SYNC_EVERY_MS }, { name: 'cost', data: {} }],
    ]);
  });

  it('adds one immediate run per job when the existing scheduler is not due yet', async () => {
    const queue = new FakeQueue();
    queue.upsertJobScheduler.mockResolvedValue({ delay: 120_000 });
    const scheduler = new PriceSyncScheduler(queue);
    scheduler.onApplicationBootstrap();
    await scheduler.whenScheduled();

    expect(queue.add.mock.calls).toEqual([
      ['fx', {}],
      ['cost', {}],
    ]);
  });

  it('does not add a second immediate run when the new scheduler already runs now', async () => {
    const queue = new FakeQueue();
    const scheduler = new PriceSyncScheduler(queue);
    scheduler.onApplicationBootstrap();
    await scheduler.whenScheduled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never rejects: a Redis failure is logged (scrubbed) and boot goes on', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const queue = new FakeQueue();
    queue.upsertJobScheduler.mockRejectedValue(new Error('connect redis://u:hunter2@h:6379'));
    const scheduler = new PriceSyncScheduler(queue);
    scheduler.onApplicationBootstrap();
    await expect(scheduler.whenScheduled()).resolves.toBeUndefined();
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('price sync scheduling failed');
    expect(line).not.toContain('hunter2');
  });
});
