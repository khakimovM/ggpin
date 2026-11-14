import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { RecipientCheckRequest } from '@repo/shared';
import { QueueEvents, type Queue } from 'bullmq';
import { AppError } from '../../../common/exceptions/app-error';
import type { AppConfig } from '../../../config/config.module';
import { RecipientCheckClient, recipientCheckJobId } from '../recipient-check.client';

class FakeEvents extends EventEmitter {
  readonly waitUntilReady = jest.fn(() => Promise.resolve());
  readonly close = jest.fn(() => Promise.resolve());
}

jest.mock('bullmq', () => ({ QueueEvents: jest.fn() }));
const QueueEventsMock = QueueEvents as unknown as jest.Mock<FakeEvents>;

const REQUEST: RecipientCheckRequest = { productId: 'p1', input: { username: 'aziz_k' } };
const AT = new Date('2026-11-14T10:00:30.000Z');
const ID = recipientCheckJobId(REQUEST, AT);
const FOUND = { status: 'FOUND', providerRef: 'ref-1', displayName: 'Aziz' };
const WAIT_MS = 80;

describe('recipientCheckJobId', () => {
  it('is stable inside one 60 s bucket and changes with the next one', () => {
    expect(ID).toMatch(/^vr-[0-9a-f]{64}$/);
    expect(recipientCheckJobId(REQUEST, new Date('2026-11-14T10:00:00.000Z'))).toBe(ID);
    expect(recipientCheckJobId(REQUEST, new Date('2026-11-14T10:00:59.999Z'))).toBe(ID);
    expect(recipientCheckJobId(REQUEST, new Date('2026-11-14T10:01:00.000Z'))).not.toBe(ID);
  });

  it('depends on the product and the input, not on key order, and holds no plain input', () => {
    expect(recipientCheckJobId({ ...REQUEST, productId: 'p2' }, AT)).not.toBe(ID);
    expect(recipientCheckJobId({ ...REQUEST, input: { username: 'aziz_l' } }, AT)).not.toBe(ID);
    const ab = recipientCheckJobId({ productId: 'p1', input: { a: '1', b: '2' } }, AT);
    const ba = recipientCheckJobId({ productId: 'p1', input: { b: '2', a: '1' } }, AT);
    expect(ab).toBe(ba);
    expect(ID).not.toContain('aziz');
  });
});

interface StoredJob {
  readonly state: string;
  readonly returnvalue?: unknown;
}

describe('RecipientCheckClient.check', () => {
  const config = { REDIS_URL: 'redis://localhost:6379/15' } as AppConfig;
  const unhandled: unknown[] = [];
  const warnings: Error[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    unhandled.length = 0;
    warnings.length = 0;
    process.on('unhandledRejection', onUnhandled);
    process.on('warning', onWarning);
    QueueEventsMock.mockImplementation(() => new FakeEvents());
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Let any stray promise settle before checking that none escaped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandled);
    process.off('warning', onWarning);
    expect(unhandled).toEqual([]);
    expect(warnings).toEqual([]);
    // Fixed text only: never the job id (a hash of the input) nor the input itself.
    for (const [message] of warn.mock.calls) expect(String(message)).not.toMatch(/vr-|aziz|ref-1/);
    warn.mockRestore();
  });

  function setup(options: { job?: StoredJob | Error; addError?: Error } = {}) {
    const add = jest.fn(() =>
      options.addError === undefined
        ? Promise.resolve({ id: ID })
        : Promise.reject(options.addError),
    );
    const stored = options.job ?? { state: 'waiting' };
    const getJobState = jest.fn(() =>
      stored instanceof Error ? Promise.reject(stored) : Promise.resolve(stored.state),
    );
    const getJob = jest.fn(() =>
      stored instanceof Error
        ? Promise.reject(stored)
        : Promise.resolve({ returnvalue: stored.returnvalue }),
    );
    const remove = jest.fn(() => Promise.resolve(1));
    const queue = { add, getJob, getJobState, remove } as unknown as Queue;
    const client = new RecipientCheckClient(queue, config, WAIT_MS, { now: () => AT });
    client.onModuleInit();
    const events = QueueEventsMock.mock.results.at(-1)?.value as FakeEvents;
    return { client, add, getJob, remove, events };
  }

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AppError) return error.code;
      throw error;
    }
    throw new Error('expected a failure');
  };

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('adds the job under the bucket id and answers from the completed event', async () => {
    const { client, add, remove, events } = setup();
    const pending = client.check(REQUEST);
    await tick();
    events.emit('completed', { jobId: ID, returnvalue: FOUND });
    await expect(pending).resolves.toEqual(FOUND);
    // Retention comes from the queue defaults (RECIPIENT_CHECK_RETENTION_SEC).
    expect(add).toHaveBeenCalledWith('validate-recipient', REQUEST, { jobId: ID });
    expect(remove).not.toHaveBeenCalled();
  });

  it('a job that already finished answers at once from its stored state', async () => {
    const { client, remove } = setup({ job: { state: 'completed', returnvalue: FOUND } });
    const started = Date.now();
    await expect(client.check(REQUEST)).resolves.toEqual(FOUND);
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(remove).not.toHaveBeenCalled();
  });

  it('NOT_FOUND is kept for the bucket; UNAVAILABLE is returned and its job removed', async () => {
    const kept = setup({ job: { state: 'completed', returnvalue: { status: 'NOT_FOUND' } } });
    await expect(kept.client.check(REQUEST)).resolves.toEqual({ status: 'NOT_FOUND' });
    expect(kept.remove).not.toHaveBeenCalled();
    const outage = setup({ job: { state: 'completed', returnvalue: { status: 'UNAVAILABLE' } } });
    await expect(outage.client.check(REQUEST)).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(outage.remove).toHaveBeenCalledWith(ID);
  });

  it('Redis refusing the job is 503', async () => {
    const { client } = setup({ addError: new Error('Connection is closed.') });
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
  });

  it('getJob or the events connection failing is 503, with no unhandled rejection', async () => {
    const broken = setup({ job: new Error('Connection is closed.') });
    expect(await code(broken.client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(broken.remove).toHaveBeenCalledWith(ID);
    const notReady = setup();
    notReady.events.waitUntilReady.mockRejectedValueOnce(new Error('Connection is closed.'));
    expect(await code(notReady.client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
  });

  it('reads the state before the data: completed then removed is 503, not an empty answer', async () => {
    const { client, getJob, remove } = setup({ job: { state: 'completed', returnvalue: FOUND } });
    getJob.mockResolvedValueOnce(undefined as never);
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(remove).toHaveBeenCalledWith(ID);
  });

  it('a job that is gone, or failed, is 503 and discarded', async () => {
    for (const state of ['unknown', 'failed']) {
      const { client, remove } = setup({ job: { state } });
      expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
      expect(remove).toHaveBeenCalledWith(ID);
    }
    const failedLater = setup();
    const pending = code(failedLater.client.check(REQUEST));
    await tick();
    failedLater.events.emit('failed', { jobId: ID, failedReason: 'boom' });
    expect(await pending).toBe('RECIPIENT_CHECK_UNAVAILABLE');
  });

  it('no answer in time is 503 and the job is discarded; the waiter is cleared', async () => {
    const { client, remove, events } = setup();
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(remove).toHaveBeenCalledWith(ID);
    // A late event finds nobody waiting and changes nothing.
    events.emit('completed', { jobId: ID, returnvalue: FOUND });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('an answer that does not parse is 503 and the job is discarded', async () => {
    for (const returnvalue of [
      null,
      'FOUND',
      { status: 'FOUND', displayName: 'Aziz' },
      { status: 'FOUND', providerRef: 'r', displayName: 'Aziz', photoUrl: 'https://x.test/a' },
    ]) {
      const { client, remove } = setup({ job: { state: 'completed', returnvalue } });
      expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
      expect(remove).toHaveBeenCalledTimes(1);
    }
  });

  it('12 concurrent waits on one job: one listener pair, one answer for all, no warning', async () => {
    const { client, events } = setup();
    const pending = Array.from({ length: 12 }, () => client.check(REQUEST));
    await tick();
    expect(events.listenerCount('completed')).toBe(1);
    expect(events.listenerCount('failed')).toBe(1);
    events.emit('completed', { jobId: ID, returnvalue: FOUND });
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 12 }, () => FOUND));
  });

  it('a discard that fails still answers 503', async () => {
    const { client, remove } = setup();
    remove.mockRejectedValueOnce(new Error('redis down'));
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
  });

  it('before the events connection exists it answers 503 without enqueueing', async () => {
    const add = jest.fn();
    const queue = { add, remove: jest.fn() } as unknown as Queue;
    const client = new RecipientCheckClient(queue, config, WAIT_MS, { now: () => AT });
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(add).not.toHaveBeenCalled();
  });
});
