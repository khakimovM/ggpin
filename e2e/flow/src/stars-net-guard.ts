import * as net from 'node:net';

// A socket-level network guard for the flow spec (code review F7, R1): `fetch` is not the only way
// out, so every `net.Socket#connect` of this process is checked (pg, ioredis, undici and
// net.connect all end there). Only the endpoints the suite's OWN env names (DATABASE_URL,
// REDIS_URL: host and port, exactly) are let through, and only on the loopback interface; any
// other attempt is refused (the call throws before a packet leaves) and recorded, so the spec can
// assert there was none. Ports come from the URLs, so CI (5432/6379) and the local lanes
// (5433/6380) both work.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6379,
};

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * The overloaded `connect` seen as one variadic method (method syntax: assignable both ways).
 * `this: void` keeps the saved reference safe to hold; it is only ever called through
 * Reflect.apply with the socket as `this`.
 */
interface Connectable {
  connect(this: void, ...args: unknown[]): unknown;
}

export interface NetGuard {
  /** Every refused attempt, as `host:port` (or the IPC path). */
  readonly refused: readonly string[];
  /** Allowed connections seen (sanity: the suite does talk to Postgres and Redis). */
  readonly allowed: () => number;
  readonly restore: () => void;
}

export interface Target {
  readonly host: string;
  readonly port: number | null;
  readonly path: string | null;
}

/** The endpoint of a connection URL (`postgresql://...`, `redis://...`); default port by scheme. */
export function endpointOf(url: string): Endpoint {
  const parsed = new URL(url);
  const port = parsed.port === '' ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
  if (port === undefined) throw new Error(`no default port for ${parsed.protocol}`);
  return { host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'), port };
}

/** host and port of a `connect` call, whichever overload (net.connect passes [options, cb]). */
export function targetOf(args: readonly unknown[]): Target {
  const [first, second] = args;
  if (Array.isArray(first)) return targetOf(first);
  if (typeof first === 'object' && first !== null) {
    const host = 'host' in first && typeof first.host === 'string' ? first.host : 'localhost';
    const path = 'path' in first && typeof first.path === 'string' ? first.path : null;
    const port = 'port' in first && first.port !== undefined ? Number(first.port) : null;
    return { host, port, path };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { host: '', port: null, path: first };
  }
  return {
    host: typeof second === 'string' ? second : 'localhost',
    port: typeof first === 'number' || typeof first === 'string' ? Number(first) : null,
    path: null,
  };
}

/** Whether a connect target is one of the allowed endpoints (exact host and port). */
export function isAllowed(target: Target, allowed: readonly Endpoint[]): boolean {
  return (
    target.path === null && allowed.some((e) => e.host === target.host && e.port === target.port)
  );
}

/** Installs the guard; every allowed endpoint must be on the loopback interface. */
export function installNetGuard(allowed: readonly Endpoint[]): NetGuard {
  if (allowed.some((e) => !LOOPBACK.has(e.host))) {
    throw new Error('the flow e2e talks to loopback Postgres/Redis only (DATABASE_URL, REDIS_URL)');
  }
  const proto: Connectable = net.Socket.prototype;
  const real = proto.connect;
  const refused: string[] = [];
  let count = 0;
  proto.connect = function guardedConnect(this: unknown, ...args: unknown[]): unknown {
    const t = targetOf(args);
    if (!isAllowed(t, allowed)) {
      refused.push(t.path ?? `${t.host}:${String(t.port)}`);
      throw new Error('network access outside the test Postgres/Redis in a dry-run test');
    }
    count += 1;
    const result: unknown = Reflect.apply(real, this, args);
    return result;
  };
  return {
    refused,
    allowed: () => count,
    restore: () => {
      proto.connect = real;
    },
  };
}
