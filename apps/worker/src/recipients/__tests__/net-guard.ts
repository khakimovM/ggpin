import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// Plan §8 network guard for a describe block (same rules as fulfill-dry-run-net.e2e-spec.ts):
// global fetch, http(s) and TLS throw; a TCP connection is allowed only to the test's own
// Postgres and Redis (any loopback spelling of their ports).

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function endpointOf(url: string): string {
  const parsed = new URL(url);
  const port =
    parsed.port === '' ? (parsed.protocol.startsWith('redis') ? '6379' : '5432') : parsed.port;
  return `${parsed.hostname}:${port}`;
}

function targetOf(args: unknown[]): string {
  const [first, second] = args;
  // net.createConnection hands connect() its normalized arguments as one array.
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

const split = (target: string): [string, string] => [
  target.slice(0, target.lastIndexOf(':')),
  target.slice(target.lastIndexOf(':') + 1),
];

const blocked = () => {
  throw new Error('network access in a dry-run test');
};

/** Installs the guard for the enclosing describe; call `expectNoOutsideAccess()` in a test. */
export function guardNetwork(urls: readonly string[]) {
  const allowedSet = new Set(urls.map(endpointOf));
  const attempts: string[] = [];
  const spies: jest.SpyInstance[] = [];
  const connect: unknown = Reflect.get(net.Socket.prototype, 'connect');

  const allowed = (target: string): boolean => {
    if (allowedSet.has(target)) return true;
    const [host, port] = split(target);
    return (
      LOOPBACK.has(host) &&
      [...allowedSet].some((a) => {
        const [allowedHost, allowedPort] = split(a);
        return allowedPort === port && LOOPBACK.has(allowedHost);
      })
    );
  };

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
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  return {
    expectNoOutsideAccess(): void {
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(tls.connect).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
      expect(attempts.filter((target) => !allowed(target))).toEqual([]);
    },
  };
}
