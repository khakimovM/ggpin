import { randomBytes } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { FRAGMENT_HEALTH_KEY, QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import type { WorkerConfig } from '../../../config/config.module';
import { FragmentSessionKey } from '../../../config/fragment-session-env';
import type { AdapterRouter } from '../../../fulfillment/adapter-router';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  SYNTHETIC_LOGGED_IN_PAGE,
  SYNTHETIC_LOGGED_OUT_PAGE,
  SYNTHETIC_PAGE_HASH,
} from '../../simulator/synthetic-fragment-pages';
import { FragmentHealth } from '../fragment-health';
import { FragmentHttp, type FragmentFetch } from '../fragment-http';
import { FragmentKeepaliveService } from '../fragment-keepalive.service';
import { FragmentNotifier, deathRef } from '../fragment-notifier';
import { LiveFragmentProbe } from '../fragment-probe';
import { FragmentSessionRepository } from '../fragment-session.repository';
import { FragmentSessionStore } from '../fragment-session.store';
import {
  captureLogs,
  clearFragmentState,
  fragmentAlerts,
  removeFragmentAlerts,
} from './fragment-e2e.harness';

// The keep-alive on the real database and Redis DB 15 (phase 5 S7), with the LIVE probe over a
// FAKE fetch (synthetic pages): the encrypted Set-Cookie refresh, one death -> one alert, the
// recovery, two replicas at once, and logs without a cookie, the hash or a page.

const env = buildE2eEnv();
const PERIOD = 1_200_000;
const KEY = new FragmentSessionKey(randomBytes(32).toString('base64'));
const JAR = {
  cookies: new Map([
    ['stel_ssid', 'sess-one'],
    ['stel_token', 'token-one'],
  ]),
  pageHash: null,
};
const SECRETS = ['sess-one', 'sess-two', 'token-one', SYNTHETIC_PAGE_HASH, '<html', 'Log in'];

type Page = 'IN' | 'OUT';

const state = {} as { db: PrismaClient; redis: Redis; notify: Queue };
let page: Page = 'IN';
let setCookies: string[] = [];
/** When set, each fetch waits until this many fetches are in flight (two replicas at once). */
let barrier: { need: number; arrived: number; open: () => void; opened: Promise<void> } | null =
  null;

function holdUntil(need: number): void {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  barrier = { need, arrived: 0, open, opened };
}

const fakeFetch: FragmentFetch = async () => {
  if (barrier !== null) {
    barrier.arrived += 1;
    if (barrier.arrived >= barrier.need) barrier.open();
    await barrier.opened;
  }
  const headers = new Headers();
  for (const line of setCookies) headers.append('set-cookie', line);
  const body = page === 'IN' ? SYNTHETIC_LOGGED_IN_PAGE : SYNTHETIC_LOGGED_OUT_PAGE;
  return new Response(body, { status: 200, headers });
};

function keepalive() {
  const prisma = { client: state.db } as unknown as PrismaService;
  const redis = { client: state.redis } as unknown as RedisService;
  const sessions = new FragmentSessionRepository(prisma);
  const store = new FragmentSessionStore(prisma, KEY);
  const forgetHealth = jest.fn();
  const router = { forgetHealth } as unknown as AdapterRouter;
  const config = { FRAGMENT_KEEPALIVE_EVERY_MS: PERIOD } as WorkerConfig;
  const probe = new LiveFragmentProbe(store, new FragmentHttp({ fetch: fakeFetch }));
  const service = new FragmentKeepaliveService(
    sessions,
    new FragmentHealth(redis, sessions),
    new FragmentNotifier(state.notify),
    router,
    config,
    probe,
  );
  return { service, store, forgetHealth };
}

const row = (id: string) => state.db.fragmentSession.findUniqueOrThrow({ where: { id } });

beforeAll(() => {
  state.db = createPrismaClient(env.DATABASE_URL);
  state.redis = new Redis(env.REDIS_URL);
  state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: env.REDIS_URL } });
});

let logs: ReturnType<typeof captureLogs>;

beforeEach(async () => {
  page = 'IN';
  setCookies = [];
  barrier = null;
  await clearFragmentState(state.db, state.redis);
  await removeFragmentAlerts(state.notify);
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  const printed = logs.lines.join('\n');
  for (const secret of SECRETS) expect(printed).not.toContain(secret);
});

afterAll(async () => {
  await clearFragmentState(state.db, state.redis);
  await removeFragmentAlerts(state.notify);
  await state.notify.close();
  state.redis.disconnect();
  await state.db.$disconnect();
});

describe('Fragment keep-alive (S7)', () => {
  it('logged in: lastOkAt, Redis ok for three periods, every Set-Cookie stored encrypted', async () => {
    const { service, store } = keepalive();
    const id = await store.importSession(JAR);
    setCookies = ['stel_ssid=sess-two; Path=/; HttpOnly; Secure'];
    await expect(service.tick()).resolves.toBe('OK');
    const after = await row(id);
    expect(after.status).toBe('ACTIVE');
    expect(after.lastOkAt).not.toBeNull();
    expect(after.pageHash).toBeNull(); // the hash lives in the sealed blob only
    expect(after.cookiesEnc).not.toContain('sess-two');
    expect(store.open(after.cookiesEnc)).toEqual({
      cookies: new Map([
        ['stel_ssid', 'sess-two'],
        ['stel_token', 'token-one'],
      ]),
      pageHash: SYNTHETIC_PAGE_HASH,
    });
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('ok');
    const ttl = await state.redis.pttl(FRAGMENT_HEALTH_KEY);
    expect(ttl).toBeGreaterThan(PERIOD * 3 - 10_000);
    expect(ttl).toBeLessThanOrEqual(PERIOD * 3);
  });

  it('two failures in a row: DEAD, Redis down, ONE fragmentSessionDead however often it looks', async () => {
    const { service, store, forgetHealth } = keepalive();
    const id = await store.importSession(JAR);
    await service.tick();
    page = 'OUT';
    await expect(service.tick()).resolves.toBe('FAILING');
    expect((await row(id)).status).toBe('ACTIVE');
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('ok');
    await expect(service.tick()).resolves.toBe('DEAD');
    const dead = await row(id);
    expect(dead).toMatchObject({ status: 'DEAD', lastError: 'LOGGED_OUT' });
    expect(dead.deadAt).not.toBeNull();
    expect(forgetHealth).toHaveBeenCalledWith('FRAGMENT');
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('down');
    for (let i = 0; i < 3; i += 1) await expect(service.tick()).resolves.toBe('DEAD');
    const ref = deathRef(id, dead.deadAt ?? new Date(0));
    expect(await fragmentAlerts(state.notify)).toEqual([
      { kind: 'OWNER_ALERT', alert: 'fragmentSessionDead', refId: ref },
    ]);
    expect(logs.lines.some((l) => l.includes(`fragment session ${id} is DEAD (LOGGED_OUT)`))).toBe(
      true,
    );
  });

  it('one blip is not a death: a logged-in page in between starts the count again', async () => {
    const { service, store } = keepalive();
    const id = await store.importSession(JAR);
    page = 'OUT';
    await expect(service.tick()).resolves.toBe('FAILING');
    page = 'IN';
    await expect(service.tick()).resolves.toBe('OK');
    page = 'OUT';
    await expect(service.tick()).resolves.toBe('FAILING');
    expect((await row(id)).status).toBe('ACTIVE');
    expect(await fragmentAlerts(state.notify)).toEqual([]);
  });

  it('two replicas see the second failure at once: one death, one alert', async () => {
    const a = keepalive();
    const b = keepalive();
    const id = await a.store.importSession(JAR);
    page = 'OUT';
    await a.service.tick();
    holdUntil(2); // both have read the ACTIVE row before either moves it
    // Two clocks: a refId built from the looker's own time (not the death's) would show up here.
    const now = Date.now();
    const results = await Promise.all([
      a.service.tick(new Date(now)),
      b.service.tick(new Date(now + 1_000)),
    ]);
    expect([...results].sort()).toEqual(['DEAD', 'NONE']);
    expect((await row(id)).status).toBe('DEAD');
    expect(await fragmentAlerts(state.notify)).toHaveLength(1);
  });

  it('a dead page that logs in again (an outage): ACTIVE again, restored for that death', async () => {
    const { service, store } = keepalive();
    const id = await store.importSession(JAR);
    page = 'OUT';
    await service.tick();
    await service.tick();
    const { deadAt } = await row(id);
    page = 'IN';
    await expect(service.tick()).resolves.toBe('RESTORED');
    expect(await row(id)).toMatchObject({ status: 'ACTIVE', deadAt: null, lastError: null });
    await expect(state.redis.get(FRAGMENT_HEALTH_KEY)).resolves.toBe('ok');
    const ref = deathRef(id, deadAt ?? new Date(0));
    expect(await fragmentAlerts(state.notify)).toEqual([
      { kind: 'OWNER_ALERT', alert: 'fragmentSessionDead', refId: ref },
      { kind: 'OWNER_ALERT', alert: 'fragmentSessionRestored', refId: ref },
    ]);
    await expect(service.tick()).resolves.toBe('OK');
    expect(await fragmentAlerts(state.notify)).toHaveLength(2);
  });

  it('a new import after a death: its first OK says restored; the dead row is never revived', async () => {
    const { service, store } = keepalive();
    const first = await store.importSession(JAR);
    page = 'OUT';
    await service.tick();
    await service.tick();
    const { deadAt } = await row(first);
    page = 'IN';
    const second = await store.importSession(JAR);
    await expect(service.tick()).resolves.toBe('OK');
    await expect(service.tick()).resolves.toBe('OK');
    expect((await row(first)).status).toBe('DEAD');
    expect((await row(second)).status).toBe('ACTIVE');
    const ref = deathRef(first, deadAt ?? new Date(0));
    expect(await fragmentAlerts(state.notify)).toEqual([
      { kind: 'OWNER_ALERT', alert: 'fragmentSessionDead', refId: ref },
      { kind: 'OWNER_ALERT', alert: 'fragmentSessionRestored', refId: ref },
    ]);
  });

  it('an import that replaces a live session is not a death: no alert, no deadAt', async () => {
    const { service, store } = keepalive();
    const first = await store.importSession(JAR);
    await service.tick();
    await store.importSession(JAR);
    await expect(service.tick()).resolves.toBe('OK');
    expect(await row(first)).toMatchObject({ status: 'DEAD', deadAt: null, lastError: 'REPLACED' });
    expect(await fragmentAlerts(state.notify)).toEqual([]);
  });

  it('no session at all: the Redis value is removed (the API shows disabled)', async () => {
    const { service } = keepalive();
    await state.redis.set(FRAGMENT_HEALTH_KEY, 'ok');
    await expect(service.tick()).resolves.toBe('NONE');
    await expect(state.redis.exists(FRAGMENT_HEALTH_KEY)).resolves.toBe(0);
  });
});
