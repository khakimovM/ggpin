import { BANKFEED_PROCESS_HEARTBEAT_KEY, WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { loadHealthcheckRole } from '../../config/healthcheck-env';
import { workerIsHealthy } from '../healthcheck';

// D-76: the HEALTHCHECK reads the process key of its own role.

const BEAT = '{"at":"2026-11-26T00:00:00.000Z","pid":1}';

function readerWith(keys: readonly string[]) {
  return { get: jest.fn((key: string) => Promise.resolve(keys.includes(key) ? BEAT : null)) };
}

describe('workerIsHealthy by role', () => {
  it('fulfillment reads worker:heartbeat only', async () => {
    const reader = readerWith([WORKER_HEARTBEAT_KEY]);
    await expect(workerIsHealthy(reader, 'fulfillment')).resolves.toBe(true);
    expect(reader.get.mock.calls).toEqual([[WORKER_HEARTBEAT_KEY]]);
  });

  it('bankfeed reads bankfeed:process-heartbeat only', async () => {
    const reader = readerWith([BANKFEED_PROCESS_HEARTBEAT_KEY]);
    await expect(workerIsHealthy(reader, 'bankfeed')).resolves.toBe(true);
    expect(reader.get.mock.calls).toEqual([[BANKFEED_PROCESS_HEARTBEAT_KEY]]);
  });

  it('a bankfeed container is not made healthy by the fulfillment key, nor the other way', async () => {
    await expect(workerIsHealthy(readerWith([WORKER_HEARTBEAT_KEY]), 'bankfeed')).resolves.toBe(
      false,
    );
    await expect(
      workerIsHealthy(readerWith([BANKFEED_PROCESS_HEARTBEAT_KEY]), 'fulfillment'),
    ).resolves.toBe(false);
  });

  it('all needs both keys', async () => {
    const both = [WORKER_HEARTBEAT_KEY, BANKFEED_PROCESS_HEARTBEAT_KEY];
    await expect(workerIsHealthy(readerWith(both), 'all')).resolves.toBe(true);
    await expect(workerIsHealthy(readerWith([WORKER_HEARTBEAT_KEY]), 'all')).resolves.toBe(false);
    await expect(
      workerIsHealthy(readerWith([BANKFEED_PROCESS_HEARTBEAT_KEY]), 'all'),
    ).resolves.toBe(false);
  });
});

describe('loadHealthcheckRole', () => {
  it('follows the worker rules', () => {
    expect(loadHealthcheckRole({ NODE_ENV: 'production', WORKER_ROLE: 'fulfillment' })).toBe(
      'fulfillment',
    );
    expect(loadHealthcheckRole({ NODE_ENV: 'production', WORKER_ROLE: 'bankfeed' })).toBe(
      'bankfeed',
    );
    expect(loadHealthcheckRole({ NODE_ENV: 'production' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'production', WORKER_ROLE: '' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'production', WORKER_ROLE: 'all' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'development', WORKER_ROLE: 'Bankfeed' })).toBeNull();
    expect(loadHealthcheckRole({ NODE_ENV: 'development' })).toBe('all');
  });
});
