import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { PAST_VALID_SEC, TEST_TIMING, pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { untilSecondLook } from '../../../ton/__tests__/ton-e2e.fixtures';
import { countsOf, useReconcileE2e } from './reconcile-e2e.harness';

// Plan §8 / rules/45 for the order reconciler: with FULFILLMENT_DRY_RUN=true its ticks (a chain
// look, a delivery and a refund) reach nothing but the test's own Postgres and Redis. Every other
// way out throws for the whole file: global fetch, http(s), TLS, and any TCP connection to another
// host or port (the fulfill-dry-run-net pattern).

const r = useReconcileE2e();
const { t } = r;

function endpointOf(url: string): string {
  const parsed = new URL(url);
  const port =
    parsed.port === '' ? (parsed.protocol.startsWith('redis') ? '6379' : '5432') : parsed.port;
  return `${parsed.hostname}:${port}`;
}

const ALLOWED = new Set([endpointOf(t.env.DATABASE_URL), endpointOf(t.env.REDIS_URL)]);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const attempts: string[] = [];

function targetOf(args: unknown[]): string {
  const [first, second] = args;
  if (Array.isArray(first)) return targetOf(first);
  if (typeof first === 'number')
    return `${typeof second === 'string' ? second : 'localhost'}:${String(first)}`;
  if (typeof first === 'object' && first !== null) {
    const port: unknown = Reflect.get(first, 'port');
    const host: unknown = Reflect.get(first, 'host');
    if (typeof port !== 'number' && typeof port !== 'string') return 'ipc';
    return `${typeof host === 'string' ? host : 'localhost'}:${String(port)}`;
  }
  return 'unknown';
}

function allowed(target: string): boolean {
  if (ALLOWED.has(target)) return true;
  const cut = target.lastIndexOf(':');
  const [host, port] = [target.slice(0, cut), target.slice(cut + 1)];
  return (
    LOOPBACK.has(host) &&
    [...ALLOWED].some((a) => a.endsWith(`:${port}`) && LOOPBACK.has(a.slice(0, a.lastIndexOf(':'))))
  );
}

const blocked = () => {
  throw new Error('network access in a dry-run test');
};

describe('dry run: the order reconciler reaches only Postgres and Redis (plan §8)', () => {
  const spies: jest.SpyInstance[] = [];
  const connect: unknown = Reflect.get(net.Socket.prototype, 'connect');

  beforeAll(() => {
    spies.push(
      jest.spyOn(globalThis, 'fetch').mockImplementation(blocked),
      jest.spyOn(tls, 'connect').mockImplementation(blocked),
      jest.spyOn(http, 'request').mockImplementation(blocked),
      jest.spyOn(https, 'request').mockImplementation(blocked),
      jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function guarded(
        this: net.Socket,
        ...args: unknown[]
      ) {
        const target = targetOf(args);
        attempts.push(target);
        if (!allowed(target)) throw new Error(`a dry-run test connected to ${target}`);
        if (typeof connect !== 'function')
          throw new Error('net.Socket.prototype.connect is missing');
        return Reflect.apply(connect, this, args) as net.Socket;
      }),
    );
  });

  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it('a delivery and a refund by the reconciler without any outside connection', async () => {
    const rec = await r.boot();
    const delivered = await r.timedOut(rec, 'HOLD');
    t.gateway.releaseHeld();
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ delivered: 1 });
    const refunded = await r.timedOut(rec, 'LOSE');
    pinChain(t.gateway, PAST_VALID_SEC);
    await rec.service.tick();
    await untilSecondLook(t.db, refunded.attemptId, TEST_TIMING.expiryGapSec);
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ refunded: 1 });
    expect((await r.moneyOf(delivered.orderId)).order.status).toBe('DELIVERED');
    expect((await r.moneyOf(refunded.orderId)).order.status).toBe('REFUNDED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.filter((target) => !allowed(target))).toEqual([]);
  });
});
