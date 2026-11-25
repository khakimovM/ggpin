import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { RecipientCheckRequest } from '@repo/shared';
import { QueueEvents, type Queue } from 'bullmq';
import { AppError } from '../../../common/exceptions/app-error';
import type { AppConfig } from '../../../config/config.module';
import { JobWaiters } from '../job-waiters';
import { RecipientCheckClient, recipientCheckJobId } from '../recipient-check.client';

// Unit harness for RecipientCheckClient. The spec file itself must call
// `jest.mock('bullmq', () => ({ QueueEvents: jest.fn() }))` (mocks are per test file).

export class FakeEvents extends EventEmitter {
  readonly waitUntilReady = jest.fn(() => Promise.resolve());
  readonly close = jest.fn(() => Promise.resolve());
}

export const REQUEST: RecipientCheckRequest = { productId: 'p1', input: { username: 'aziz_k' } };
export const AT = new Date('2026-11-14T10:00:30.000Z');
export const ID = recipientCheckJobId(REQUEST, AT);
export const FOUND = { status: 'FOUND', providerRef: 'ref-1', displayName: 'Aziz' };
export const WAIT_MS = 80;
export const config = { REDIS_URL: 'redis://localhost:6379/15' } as AppConfig;

export interface StoredJob {
  readonly state: string;
  readonly returnvalue?: unknown;
}

/** The client's private waiter registry, read for the "every wait leaves it empty" check. */
export function waitersOf(client: RecipientCheckClient): JobWaiters {
  const waiters: unknown = Reflect.get(client, 'waiters');
  if (!(waiters instanceof JobWaiters)) throw new Error('RecipientCheckClient.waiters moved');
  return waiters;
}

export const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
};

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Registers the per-test hooks and returns `setup`. After every test: no unhandled rejection,
 * no process warning, log lines without the job id or input, and every client's waiter
 * registry empty (whichever way its waits ended).
 */
export function useClientHarness() {
  const QueueEventsMock = QueueEvents as unknown as jest.Mock<FakeEvents>;
  const unhandled: unknown[] = [];
  const warnings: Error[] = [];
  const clients: RecipientCheckClient[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  const state: { warn?: jest.SpyInstance } = {};

  beforeEach(() => {
    unhandled.length = 0;
    warnings.length = 0;
    clients.length = 0;
    process.on('unhandledRejection', onUnhandled);
    process.on('warning', onWarning);
    QueueEventsMock.mockImplementation(() => new FakeEvents());
    state.warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Let any stray promise settle before checking that none escaped.
    await sleep(20);
    process.off('unhandledRejection', onUnhandled);
    process.off('warning', onWarning);
    expect(unhandled).toEqual([]);
    expect(warnings).toEqual([]);
    for (const client of clients) expect(waitersOf(client).size).toBe(0);
    // Fixed text only: never the job id (a hash of the input) nor the input itself.
    for (const [message] of warnLog().mock.calls) {
      expect(String(message)).not.toMatch(/vr-|aziz|ref-1/);
    }
    state.warn?.mockRestore();
  });

  const warnLog = (): jest.SpyInstance => {
    if (state.warn === undefined) throw new Error('harness hooks did not run');
    return state.warn;
  };

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
    clients.push(client);
    const events = QueueEventsMock.mock.results.at(-1)?.value as FakeEvents;
    return { client, add, getJob, getJobState, remove, events };
  }

  return { setup, warnLog };
}
