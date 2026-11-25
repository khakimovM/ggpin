import * as net from 'node:net';
import { endpointOf, installNetGuard, isAllowed, targetOf } from './stars-net-guard';

// The flow spec's network guard on its own (review R1): no database, no Redis, no socket is
// opened. The allow list comes from the env URLs, so the CI ports (5432/6379) pass as well as the
// local lanes' (5433/6380), and nothing else does.

const CI = [
  endpointOf('postgresql://ggpin:ggpin@localhost:5432/ggpin_test'),
  endpointOf('redis://localhost:6379/15'),
];
const noop = (): void => undefined;
/** The prototype seen like the guard sees it (a `this: void` method: safe to hold a reference). */
const proto: { connect(this: void, ...args: unknown[]): unknown } = net.Socket.prototype;

describe('stars-net-guard', () => {
  it('reads host and port from the env URLs, with the default port of the scheme', () => {
    expect(CI).toEqual([
      { host: 'localhost', port: 5432 },
      { host: 'localhost', port: 6379 },
    ]);
    expect(endpointOf('postgresql://u@localhost/db_test')).toEqual({
      host: 'localhost',
      port: 5432,
    });
    expect(endpointOf('redis://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 6379 });
    expect(endpointOf('redis://[::1]:6380/15')).toEqual({ host: '::1', port: 6380 });
    expect(endpointOf('postgresql://ggpin:ggpin@localhost:5433/x_test')).toEqual({
      host: 'localhost',
      port: 5433,
    });
  });

  it('allows exactly the CI endpoints, in every connect overload', () => {
    expect(isAllowed(targetOf([5432, 'localhost']), CI)).toBe(true); // pg
    expect(isAllowed(targetOf([{ host: 'localhost', port: 6379 }]), CI)).toBe(true); // ioredis
    expect(isAllowed(targetOf([[{ host: 'localhost', port: '6379' }, noop]]), CI)).toBe(true); // net.connect
    expect(isAllowed(targetOf(['5432', 'localhost', noop]), CI)).toBe(true);
  });

  it('refuses another port, another host (exact match) and IPC paths', () => {
    for (const args of [
      [5433, 'localhost'],
      [{ host: 'localhost', port: 6380 }],
      [5432, '127.0.0.1'],
      [443, 'example.com'],
      [{ host: 'toncenter.com', port: 443 }],
      ['/tmp/x.sock'],
      [{ path: '/tmp/x.sock' }],
    ]) {
      expect(isAllowed(targetOf(args), CI)).toBe(false);
    }
    expect(isAllowed(targetOf([5432, 'localhost']), [])).toBe(false);
  });

  it('refuses a non-loopback allow list at install', () => {
    expect(() => installNetGuard([{ host: 'db.example.com', port: 5432 }])).toThrow(/loopback/);
  });

  it('an installed guard throws before connecting, records it, and restores the prototype', () => {
    const before = proto.connect;
    const guard = installNetGuard(CI);
    try {
      const socket = new net.Socket();
      expect(() => socket.connect(443, 'example.com')).toThrow(/network access/);
      expect(() => net.connect({ host: 'localhost', port: 6380 })).toThrow(/network access/);
      socket.destroy();
      expect(guard.refused).toEqual(['example.com:443', 'localhost:6380']);
      expect(guard.allowed()).toBe(0);
    } finally {
      guard.restore();
    }
    expect(proto.connect).toBe(before);
  });
});
