import { EVENTS_CLOSE_TIMEOUT_MS } from '../recipient-check.client';
import {
  FOUND,
  ID,
  REQUEST,
  WAIT_MS,
  code,
  sleep,
  tick,
  useClientHarness,
  waitersOf,
} from './recipient-check-client.harness';

jest.mock('bullmq', () => ({ QueueEvents: jest.fn() }));

// Shared waits, shutdown, the order of the readiness wait and the state read, and error logs.
describe('RecipientCheckClient lifecycle', () => {
  const { setup, warnLog } = useClientHarness();

  it('a timed-out wait does not remove a job another request still waits for', async () => {
    const { client, remove, events } = setup();
    const first = code(client.check(REQUEST));
    await sleep(WAIT_MS / 2);
    const second = client.check(REQUEST);
    expect(await first).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    // The later request still waits for the job, so the first one left it in place.
    expect(remove).not.toHaveBeenCalled();
    expect(waitersOf(client).has(ID)).toBe(true);
    events.emit('completed', { jobId: ID, returnvalue: FOUND });
    await expect(second).resolves.toEqual(FOUND);
    expect(remove).not.toHaveBeenCalled();
  });

  it('the last waiter to time out removes the job, once', async () => {
    const { client, remove } = setup();
    const first = code(client.check(REQUEST));
    await sleep(WAIT_MS / 2);
    const second = code(client.check(REQUEST));
    expect(await first).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(remove).not.toHaveBeenCalled();
    expect(await second).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(ID);
  });

  it('reads the job state only once the events connection is ready', async () => {
    const { client, getJobState, events } = setup({
      job: { state: 'completed', returnvalue: FOUND },
    });
    let ready: () => void = () => undefined;
    events.waitUntilReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const pending = client.check(REQUEST);
    await tick();
    await tick();
    expect(events.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(getJobState).not.toHaveBeenCalled();
    ready();
    await expect(pending).resolves.toEqual(FOUND);
    expect(getJobState).toHaveBeenCalledTimes(1);
  });

  it('shutdown answers a waiting request 503 at once, and later requests without enqueueing', async () => {
    const { client, add, events } = setup();
    const pending = code(client.check(REQUEST));
    await tick();
    const started = Date.now();
    await client.beforeApplicationShutdown();
    expect(await pending).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(WAIT_MS / 2);
    expect(events.close).toHaveBeenCalledTimes(1);
    expect(await code(client.check(REQUEST))).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('a request whose enqueue was in flight when shutdown began does not wait', async () => {
    const { client, add } = setup();
    let enqueued: () => void = () => undefined;
    add.mockReturnValueOnce(
      new Promise((resolve) => {
        enqueued = () => resolve({ id: ID });
      }),
    );
    const pending = code(client.check(REQUEST));
    await tick();
    await client.beforeApplicationShutdown();
    const started = Date.now();
    enqueued();
    expect(await pending).toBe('RECIPIENT_CHECK_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(WAIT_MS / 2);
  });

  it('an events close that never ends gives up after the timeout with a fixed warning', async () => {
    const { client, events } = setup();
    events.close.mockReturnValueOnce(new Promise<void>(() => undefined));
    jest.useFakeTimers();
    try {
      let done = false;
      const shutdown = client.beforeApplicationShutdown().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(EVENTS_CLOSE_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    expect(warnLog()).toHaveBeenCalledWith('queue events connection did not close in time');
  });

  it('an events close that fails does not fail the shutdown', async () => {
    const { client, events } = setup();
    events.close.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(client.beforeApplicationShutdown()).resolves.toBeUndefined();
    expect(warnLog()).not.toHaveBeenCalled();
  });

  it('an events error with an empty message is logged by its code or name, scrubbed otherwise', () => {
    const { events } = setup();
    const refused = new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:6399')], '');
    Reflect.set(refused, 'code', 'ECONNREFUSED');
    events.emit('error', refused);
    events.emit('error', new AggregateError([], ''));
    events.emit('error', new Error('connect to redis://:hunter2@cache:6379 failed'));
    const lines = warnLog().mock.calls.map(([message]) => String(message));
    expect(lines.slice(0, 2)).toEqual([
      'queue events error: ECONNREFUSED',
      'queue events error: AggregateError',
    ]);
    expect(lines[2]).toMatch(/^queue events error: /);
    expect(lines[2]).not.toContain('hunter2');
  });

  it('an empty-message error whose code is not a plain error code is logged by its name only', () => {
    const { events } = setup();
    const withCode = (code: string): AggregateError => {
      const error = new AggregateError([], '');
      Reflect.set(error, 'code', code);
      return error;
    };
    // A plain code in between, as the same line twice in a row is logged once.
    events.emit('error', withCode('redis://u:hunter2@cache'));
    events.emit('error', withCode('ECONNRESET'));
    events.emit('error', withCode('econnrefused'));
    expect(warnLog().mock.calls.map(([message]) => String(message))).toEqual([
      'queue events error: AggregateError',
      'queue events error: ECONNRESET',
      'queue events error: AggregateError',
    ]);
  });
});
