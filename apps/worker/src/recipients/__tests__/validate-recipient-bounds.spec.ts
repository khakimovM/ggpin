import { setTimeout as sleep } from 'node:timers/promises';
import {
  VALIDATE_RECIPIENT_CONCURRENCY,
  VALIDATE_RECIPIENT_LIMITER,
} from '../recipient-check.config';
import {
  ValidateRecipientProcessor,
  WORKER_ERROR_REPEAT_MS,
} from '../validate-recipient.processor';
import { FOUND, TIMING, build, job, request } from './processor-harness';
import { stubAdapter } from './recipient-test-doubles';

// Limits of validate-recipient that a mutation must not slip past (S3b review CR #1, #3, #6;
// audit L-1, L-3, L-4): the worker options BullMQ is given, the worker error listener, and the
// deadline's edges. Metadata keys are @nestjs/bullmq's (bull.constants.js).

const WORKER_METADATA = 'bullmq:worker_metadata';
const ON_WORKER_EVENT_METADATA = 'bullmq:worker_events_metadata';
const hang = () => new Promise<never>(() => undefined);

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('worker options (the only guard of the Fragment session)', () => {
  it('@Processor gives BullMQ concurrency 10 and a limiter of 1 job per 1000 ms', () => {
    const options: unknown = Reflect.getMetadata(WORKER_METADATA, ValidateRecipientProcessor);
    expect(options).toEqual({ concurrency: 10, limiter: { max: 1, duration: 1_000 } });
    expect(VALIDATE_RECIPIENT_LIMITER).toEqual({ max: 1, duration: 1_000 });
    expect(VALIDATE_RECIPIENT_CONCURRENCY).toBe(10);
  });
});

describe('worker error listener (audit L-1)', () => {
  it('is registered for the worker `error` event', () => {
    const handler: unknown = Reflect.get(ValidateRecipientProcessor.prototype, 'onWorkerError');
    const meta: unknown =
      typeof handler === 'function' ? Reflect.getMetadata(ON_WORKER_EVENT_METADATA, handler) : null;
    expect(meta).toEqual(expect.objectContaining({ eventName: 'error' }));
  });

  it('logs the class name only, once per change, again after the repeat period', () => {
    const { processor, logs } = build();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const lost = new Error('Missing lock for job vr-0123456789abcdef. moveToFinished');
    processor.onWorkerError(lost);
    processor.onWorkerError(lost);
    processor.onWorkerError(new TypeError('vr-0123456789abcdef again'));
    now.mockReturnValue(1_000_000 + WORKER_ERROR_REPEAT_MS);
    processor.onWorkerError(new TypeError('vr-0123456789abcdef again'));
    processor.onWorkerError('not an error');
    expect(logs).toEqual([
      'validate-recipient worker error: Error',
      'validate-recipient worker error: TypeError',
      'validate-recipient worker error: TypeError',
      'validate-recipient worker error: nonError',
    ]);
    expect(logs.join('\n')).not.toContain('vr-');
  });
});

describe('deadline edges (audit L-4, CR #6)', () => {
  it('a job timestamp in the future is capped: the slot is held at most wait - margin', async () => {
    const { processor } = build({ adapters: [stubAdapter('FRAGMENT', { validate: hang })] });
    const started = Date.now();
    await expect(processor.process(job(request(), started + 60_000))).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(TIMING.waitMs - TIMING.replyMarginMs - 20);
    expect(took).toBeLessThan(TIMING.waitMs + 200);
  });

  it('a slow database leaves less than minCallMs: the provider is not asked', async () => {
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const { processor, find, logs } = build({
      adapters: [stubAdapter('FRAGMENT', { validate })],
    });
    const budget = TIMING.waitMs - TIMING.replyMarginMs;
    const product = await find();
    find.mockImplementation(() => sleep(budget - TIMING.minCallMs + 20).then(() => product));
    await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(validate).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('UNAVAILABLE (TIMEOUT) adapter=FRAGMENT');
  });

  it('a hanging health() is cut by the deadline around the route pick', async () => {
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const sick = stubAdapter('FRAGMENT', { health: hang, validate });
    const { processor, logs } = build({ adapters: [sick] });
    await expect(processor.process(job(request()))).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(validate).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('UNAVAILABLE (TIMEOUT) adapter=-');
  });

  it('exactly minCallMs left still asks the provider; one millisecond less is STALE', async () => {
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const { processor, find } = build({ adapters: [stubAdapter('FRAGMENT', { validate })] });
    const now = 5_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const edge = now - (TIMING.waitMs - TIMING.replyMarginMs - TIMING.minCallMs);
    await expect(processor.process(job(request(), edge))).resolves.toEqual(FOUND);
    expect(validate).toHaveBeenCalledTimes(1);
    await expect(processor.process(job(request(), edge - 1))).resolves.toEqual({
      status: 'UNAVAILABLE',
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('the deadline timer is disposed when the lookup ends early', async () => {
    jest.useFakeTimers();
    const { processor } = build();
    await expect(processor.process(job(request(), Date.now()))).resolves.toEqual(FOUND);
    expect(jest.getTimerCount()).toBe(0);
  });
});
