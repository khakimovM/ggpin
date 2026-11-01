import { Logger } from '@nestjs/common';
import { ReadinessSchema } from '@repo/shared';
import type { HealthRepository } from '../health.repository';
import {
  HealthService,
  READINESS_CACHE_TTL_MS,
  READINESS_CHECK_TIMEOUT_MS,
} from '../health.service';

type Repo = jest.Mocked<
  Pick<HealthRepository, 'pingDatabase' | 'pingRedis' | 'workerHeartbeatPresent'>
>;

function healthyRepo(): Repo {
  return {
    pingDatabase: jest.fn().mockResolvedValue(undefined),
    pingRedis: jest.fn().mockResolvedValue(undefined),
    workerHeartbeatPresent: jest.fn().mockResolvedValue(true),
  };
}

function build(repo: Repo): HealthService {
  // HealthService uses only these three methods.
  return new HealthService(repo as unknown as HealthRepository);
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('HealthService.readiness', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is ok when db, redis and worker are ok; fragment is disabled', async () => {
    const report = await build(healthyRepo()).readiness();
    expect(report).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      worker: 'ok',
      fragment: 'disabled',
    });
    expect(ReadinessSchema.parse(report)).toEqual(report);
  });

  it.each([
    ['db', (r: Repo) => r.pingDatabase.mockRejectedValue(new Error('ECONNREFUSED'))],
    ['redis', (r: Repo) => r.pingRedis.mockRejectedValue(new Error('ECONNREFUSED'))],
    ['worker', (r: Repo) => r.workerHeartbeatPresent.mockResolvedValue(false)],
    ['worker', (r: Repo) => r.workerHeartbeatPresent.mockRejectedValue(new Error('down'))],
  ] as const)('is degraded with %s down', async (dep, breakIt) => {
    const repo = healthyRepo();
    breakIt(repo);
    const report = await build(repo).readiness();
    expect(report.status).toBe('degraded');
    expect(report[dep]).toBe('down');
    const others = (['db', 'redis', 'worker'] as const).filter((d) => d !== dep);
    for (const other of others) expect(report[other]).toBe('ok');
  });

  it('is degraded when everything is down', async () => {
    const repo: Repo = {
      pingDatabase: jest.fn().mockRejectedValue('not even an Error'),
      pingRedis: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
      workerHeartbeatPresent: jest.fn().mockRejectedValue(new Error('down')),
    };
    const report = await build(repo).readiness();
    expect(report).toEqual({
      status: 'degraded',
      db: 'down',
      redis: 'down',
      worker: 'down',
      fragment: 'disabled',
    });
  });

  it.each(['pingDatabase', 'pingRedis', 'workerHeartbeatPresent'] as const)(
    'marks a hung %s as down after the timeout instead of hanging',
    async (method) => {
      jest.useFakeTimers();
      const repo = healthyRepo();
      repo[method].mockImplementation(never);
      let settled = false;
      const pending = build(repo)
        .readiness()
        .finally(() => (settled = true));

      await jest.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const report = await pending;
      expect(report.status).toBe('degraded');
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('runs the checks in parallel: all hung still answers within one timeout', async () => {
    jest.useFakeTimers();
    const repo: Repo = {
      pingDatabase: jest.fn().mockImplementation(never),
      pingRedis: jest.fn().mockImplementation(never),
      workerHeartbeatPresent: jest.fn().mockImplementation(never),
    };
    const pending = build(repo).readiness();
    await jest.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ status: 'degraded', db: 'down' });
  });

  it('clears its timers when checks answer quickly', async () => {
    jest.useFakeTimers();
    await build(healthyRepo()).readiness();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('HealthService.readiness cache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('serves a fresh result without probing again, then probes after the TTL', async () => {
    const repo = healthyRepo();
    const service = build(repo);
    await service.readiness();
    await service.readiness();
    await jest.advanceTimersByTimeAsync(READINESS_CACHE_TTL_MS - 1);
    await service.readiness();
    expect(repo.pingDatabase).toHaveBeenCalledTimes(1);
    expect(repo.pingRedis).toHaveBeenCalledTimes(1);
    expect(repo.workerHeartbeatPresent).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await service.readiness();
    expect(repo.pingDatabase).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const repo = healthyRepo();
    let release: () => void = () => undefined;
    repo.pingDatabase.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const service = build(repo);
    const calls = Array.from({ length: 50 }, () => service.readiness());
    await jest.advanceTimersByTimeAsync(10);
    expect(repo.pingDatabase).toHaveBeenCalledTimes(1);
    release();
    const reports = await Promise.all(calls);
    expect(reports.every((r) => r.status === 'ok')).toBe(true);
    expect(repo.pingDatabase).toHaveBeenCalledTimes(1);
    expect(repo.pingRedis).toHaveBeenCalledTimes(1);
  });

  it('caches a failing result for the same short window', async () => {
    const repo = healthyRepo();
    repo.pingDatabase.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = build(repo);
    expect((await service.readiness()).status).toBe('degraded');
    expect((await service.readiness()).status).toBe('degraded');
    expect(repo.pingDatabase).toHaveBeenCalledTimes(1);

    // Recovery is seen once the window has passed.
    repo.pingDatabase.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(READINESS_CACHE_TTL_MS);
    expect((await service.readiness()).status).toBe('ok');
  });

  it('measures the window from when the probe finished, not when it started', async () => {
    const repo = healthyRepo();
    let release: () => void = () => undefined;
    repo.pingDatabase.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const service = build(repo);
    const first = service.readiness();
    await jest.advanceTimersByTimeAsync(READINESS_CACHE_TTL_MS + 500);
    release();
    await first;
    await service.readiness();
    expect(repo.pingDatabase).toHaveBeenCalledTimes(1);
  });

  it('starts a new probe after a hung one timed out and its window passed', async () => {
    const repo = healthyRepo();
    repo.pingDatabase.mockImplementationOnce(never);
    const service = build(repo);
    const first = service.readiness();
    await jest.advanceTimersByTimeAsync(READINESS_CHECK_TIMEOUT_MS);
    expect((await first).db).toBe('down');
    await jest.advanceTimersByTimeAsync(READINESS_CACHE_TTL_MS);
    expect((await service.readiness()).db).toBe('ok');
  });

  it('hands every caller its own copy of the report', async () => {
    const service = build(healthyRepo());
    const first = await service.readiness();
    (first as { status: string }).status = 'tampered';
    expect((await service.readiness()).status).toBe('ok');
  });
});
