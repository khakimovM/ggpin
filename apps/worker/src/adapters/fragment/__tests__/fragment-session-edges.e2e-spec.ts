import { randomBytes } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { FRAGMENT_HEALTH_KEY, QUEUES, type NotifyJob } from '@repo/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { WorkerConfig } from '../../../config/config.module';
import { FragmentSessionKey } from '../../../config/fragment-session-env';
import type { AdapterRouter } from '../../../fulfillment/adapter-router';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { NoticeQueue } from '../../../ton/ton-notifier';
import { FragmentHealth } from '../fragment-health';
import { FragmentHttp } from '../fragment-http';
import { FragmentKeepaliveService } from '../fragment-keepalive.service';
import { FragmentNotifier, deathRef } from '../fragment-notifier';
import { LiveFragmentProbe, type FragmentProbe, type ProbeOutcome } from '../fragment-probe';
import { FragmentSessionRepository } from '../fragment-session.repository';
import { COOKIES_TOMBSTONE, FragmentSessionStore } from '../fragment-session.store';
import {
  captureLogs,
  clearFragmentState,
  fragmentAlerts,
  removeFragmentAlerts,
} from './fragment-e2e.harness';

// Edges of the Fragment session (phase 5 S7 fix round) on the real database and Redis DB 15:
// a lost dead alert is sent again on the next look (review m1), a session imported after a death
// is healthy for the worker at once (m2), an import wipes the cookies of every older row (audit
// I-2) and a refresh never writes over a wiped or newer blob (N-1), and a missing or wrong key
// is its own log code (L-4). No fetch ever runs here.

const env = buildE2eEnv();
const PERIOD = 1_200_000;
const newKey = () => new FragmentSessionKey(randomBytes(32).toString('base64'));
const KEY = newKey();
const JAR = { cookies: new Map([['stel_ssid', 'sess-one']]), pageHash: null };
const state = {} as { db: PrismaClient; redis: Redis; notify: Queue };

/** A probe whose answer the test sets. */
class ScriptedProbe implements FragmentProbe {
  outcome: ProbeOutcome = { kind: 'OK' };
  check(): Promise<ProbeOutcome> {
    return Promise.resolve(this.outcome);
  }
}

const noFetch = () => Promise.reject(new Error('no fetch in this suite'));

interface BuildOptions {
  readonly queue?: NoticeQueue;
  readonly key?: FragmentSessionKey;
}

function build(probe: FragmentProbe, options: BuildOptions = {}) {
  const prisma = { client: state.db } as unknown as PrismaService;
  const redis = { client: state.redis } as unknown as RedisService;
  const sessions = new FragmentSessionRepository(prisma);
  const health = new FragmentHealth(redis, sessions);
  const router = { forgetHealth: jest.fn() } as unknown as AdapterRouter;
  const config = {
    FRAGMENT_KEEPALIVE_EVERY_MS: PERIOD,
    FRAGMENT_SESSION_ENC_KEY: options.key,
  } as WorkerConfig;
  const notifier = new FragmentNotifier(options.queue ?? state.notify);
  const service = new FragmentKeepaliveService(sessions, health, notifier, router, config, probe);
  return { service, health, store: new FragmentSessionStore(prisma, KEY) };
}

async function dieWith(service: FragmentKeepaliveService, probe: ScriptedProbe) {
  probe.outcome = { kind: 'FAIL', code: 'LOGGED_OUT' };
  await expect(service.tick()).resolves.toBe('FAILING');
  return service.tick();
}

const row = (id: string) => state.db.fragmentSession.findUniqueOrThrow({ where: { id } });

beforeAll(() => {
  state.db = createPrismaClient(env.DATABASE_URL);
  state.redis = new Redis(env.REDIS_URL);
  state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: env.REDIS_URL } });
});

beforeEach(async () => {
  await clearFragmentState(state.db, state.redis);
  await removeFragmentAlerts(state.notify);
});

afterAll(async () => {
  await clearFragmentState(state.db, state.redis);
  await removeFragmentAlerts(state.notify);
  await state.notify.close();
  state.redis.disconnect();
  await state.db.$disconnect();
});

describe('Fragment session edges (S7 fix round)', () => {
  it('m1: the dead alert is lost at the death -> the next look sends exactly one', async () => {
    const probe = new ScriptedProbe();
    let failNext = false;
    const queue: NoticeQueue = {
      add: (name, data, options) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('redis went away'));
        }
        return state.notify.add(name, data, options);
      },
    };
    const { service, store } = build(probe, { queue });
    const id = await store.importSession(JAR);
    await expect(service.tick()).resolves.toBe('OK');
    failNext = true;
    const logs = captureLogs();
    try {
      await expect(dieWith(service, probe)).resolves.toBe('DEAD');
    } finally {
      logs.restore();
    }
    expect(logs.lines.join('\n')).toContain('fragmentSessionDead not queued');
    expect(await fragmentAlerts(state.notify)).toEqual([]);
    await expect(service.tick()).resolves.toBe('DEAD');
    await expect(service.tick()).resolves.toBe('DEAD');
    const { deadAt } = await row(id);
    const dead: NotifyJob = {
      kind: 'OWNER_ALERT',
      alert: 'fragmentSessionDead',
      refId: deathRef(id, deadAt ?? new Date(0)),
    };
    expect(await fragmentAlerts(state.notify)).toEqual([dead]);
  });

  it('m2: a session imported after a death is healthy for the worker at once', async () => {
    const probe = new ScriptedProbe();
    const { service, health, store } = build(probe);
    await store.importSession(JAR);
    await service.tick();
    await expect(dieWith(service, probe)).resolves.toBe('DEAD');
    await expect(health.read()).resolves.toBe('down');
    await expect(health.simulatedAdapterHealth()).resolves.toBe('DOWN');

    await store.importSession(JAR);
    // The dead session's Redis `down` is still there (the API's view until the next look) ...
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('down');
    // ... but the worker decides by the rows: the new session is used now.
    await expect(health.read()).resolves.toBe('ok');
    await expect(health.liveAdapterHealth()).resolves.toBe('OK');
    await expect(health.simulatedAdapterHealth()).resolves.toBe('OK');
    probe.outcome = { kind: 'OK' };
    await expect(service.tick()).resolves.toBe('OK');
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('ok');
  });

  it('I-2: an import wipes the cookies of the replaced row and of every older dead row', async () => {
    const probe = new ScriptedProbe();
    const { service, store } = build(probe);
    const died = await store.importSession(JAR);
    await service.tick();
    await dieWith(service, probe);
    const replaced = await store.importSession(JAR);
    expect((await row(died)).cookiesEnc).toBe(COOKIES_TOMBSTONE);
    const current = await store.importSession(JAR);
    expect(await row(replaced)).toMatchObject({
      status: 'DEAD',
      lastError: 'REPLACED',
      cookiesEnc: COOKIES_TOMBSTONE,
    });
    const live = await row(current);
    expect(live.status).toBe('ACTIVE');
    expect(store.open(live.cookiesEnc).cookies.get('stel_ssid')).toBe('sess-one');
  });

  it('N-1: a refresh read before an import never writes old cookies onto the tombstone', async () => {
    const { store } = build(new ScriptedProbe());
    const id = await store.importSession(JAR);
    const read = await row(id);
    await store.importSession(JAR);
    const rotated = { cookies: new Map([['stel_ssid', 'sess-two']]), pageHash: null };
    const asRead = { id, status: 'ACTIVE' as const, cookiesEnc: read.cookiesEnc };
    await expect(store.save(asRead, rotated)).resolves.toBe(false);
    // Probing the replaced row as DEAD (its new status) with the blob read earlier: also refused.
    await expect(store.save({ ...asRead, status: 'DEAD' }, rotated)).resolves.toBe(false);
    expect((await row(id)).cookiesEnc).toBe(COOKIES_TOMBSTONE);
  });

  it('N-1: two refreshes of the same read: the first stores, the second loses', async () => {
    const { store } = build(new ScriptedProbe());
    const id = await store.importSession(JAR);
    const read = await row(id);
    const asRead = { id, status: 'ACTIVE' as const, cookiesEnc: read.cookiesEnc };
    const jar = (value: string) => ({ cookies: new Map([['stel_ssid', value]]), pageHash: null });
    const results = await Promise.all([
      store.save(asRead, jar('sess-a')),
      store.save(asRead, jar('sess-b')),
    ]);
    expect(results.filter((stored) => stored)).toHaveLength(1);
    const winner = results[0] ? 'sess-a' : 'sess-b';
    expect(store.open((await row(id)).cookiesEnc).cookies.get('stel_ssid')).toBe(winner);
  });

  it('L-4: no key and a key that does not open the blob are two log codes of their own', async () => {
    const prisma = { client: state.db } as unknown as PrismaService;
    const { store } = build(new ScriptedProbe());
    const id = await store.importSession(JAR);
    const cases = [
      [new FragmentSessionStore(prisma), 'FRAGMENT_SESSION_NO_KEY'],
      [new FragmentSessionStore(prisma, newKey()), 'FRAGMENT_SESSION_BAD_BLOB'],
    ] as const;
    for (const [probeStore, code] of cases) {
      const probe = new LiveFragmentProbe(probeStore, new FragmentHttp({ fetch: noFetch }));
      const { service } = build(probe);
      const logs = captureLogs();
      try {
        await expect(service.tick()).resolves.toBe('FAILING');
      } finally {
        logs.restore();
      }
      const printed = logs.lines.join('\n');
      expect(printed).toContain(`fragment session ${id}: ${code}`);
      expect(printed).not.toContain('sess-one');
      await state.db.fragmentSession.update({ where: { id }, data: { lastError: null } });
    }
  });

  it('L-4: the key fingerprint is logged at boot, 8 hex, never the key', () => {
    const key = newKey();
    const { service } = build(new ScriptedProbe(), { key });
    const logs = captureLogs();
    try {
      service.onModuleInit();
    } finally {
      logs.restore();
    }
    expect(key.fingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(logs.lines.join('\n')).toContain(
      `fragment session key fingerprint ${key.fingerprint()}`,
    );
    const raw = key.bytesForSessionStore().toString('base64');
    expect(logs.lines.join('\n')).not.toContain(raw);
  });
});
