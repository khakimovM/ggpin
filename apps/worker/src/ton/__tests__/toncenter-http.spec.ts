import https from 'node:https';
import { inspect } from 'node:util';
import { Address } from '@ton/core';
import { TonApiKey } from '../../config/ton-api-key';
import { TonGatewayError } from '../ton-gateway';
import {
  TONCENTER_MAX_RESPONSE_BYTES,
  type RequestFn,
  type RequestLike,
  type ResponseLike,
} from '../toncenter-http';
import { ToncenterGateway } from '../toncenter.gateway';

// The bounded transport of the toncenter client (audit I2, the condition of the zod@3 exception
// D-60 (4)), driven through the real TonClient/axios stack with a fake `https.request`: nothing
// leaves the process. Checked: the size cap (declared and streamed), https only, no redirect
// followed, no proxy, one deadline, and no request header (the API key) in any error.

const API_KEY = ['marker', 'for', 'http', 'tests'].join('-');
const ADDRESS = new Address(0, Buffer.alloc(32, 7));
const ENDPOINT = 'https://toncenter.invalid/api/v2/jsonRPC';

interface Answer {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly chunks?: readonly Buffer[];
  /** Never answers: only the deadline ends the exchange. */
  readonly hang?: boolean;
}

interface Seen {
  url: URL | null;
  options: https.RequestOptions | null;
  destroyed: boolean;
  /** The agent of every request, in order. */
  agents: unknown[];
}

function fakeRequest(answer: Answer, seen: Seen): RequestFn {
  return (url, options, onResponse) => {
    seen.url = url;
    seen.options = options;
    seen.agents.push(options.agent);
    let onError: (error: Error) => void = () => undefined;
    const request: RequestLike = {
      on: (_event, listener) => {
        onError = listener;
        return request;
      },
      end: () => {
        if (answer.hang === true) {
          options.signal?.addEventListener('abort', () => onError(new Error('aborted')));
          return request;
        }
        const response: ResponseLike = {
          statusCode: answer.status ?? 200,
          statusMessage: 'x',
          headers: answer.headers ?? {},
          destroy: () => {
            seen.destroyed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const chunk of answer.chunks ?? []) yield await Promise.resolve(chunk);
          },
        };
        onResponse(response);
        return request;
      },
    };
    return request;
  };
}

function gatewayOn(answer: Answer, endpoint = ENDPOINT, maxBytes?: number) {
  const seen: Seen = { url: null, options: null, destroyed: false, agents: [] };
  const gateway = new ToncenterGateway({
    endpoint,
    apiKey: new TonApiKey(API_KEY),
    dryRun: false,
    timeoutMs: 200,
    transport: {
      request: fakeRequest(answer, seen),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    },
  });
  return { gateway, seen };
}

async function reasonOf(promise: Promise<unknown>): Promise<TonGatewayError['reason']> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof TonGatewayError)) throw new Error('expected a TonGatewayError');
  const text = `${error.message} ${inspect(error)} ${JSON.stringify(error)} ${String(error.stack)}`;
  expect(text).not.toContain(API_KEY);
  return error.reason;
}

const json = (value: unknown) => [Buffer.from(JSON.stringify(value))];

describe('boundedHttpsAdapter (audit I2)', () => {
  it('posts to the endpoint itself with the key header, its own agent and a deadline signal', async () => {
    const { gateway, seen } = gatewayOn({ chunks: json({ ok: true, result: { odd: 1 } }) });
    expect(await reasonOf(gateway.getBalance(ADDRESS))).toBe('MALFORMED');
    expect(seen.url?.href).toBe(ENDPOINT);
    expect(seen.options?.method).toBe('POST');
    expect(JSON.stringify(seen.options?.headers)).toContain(API_KEY);
    // Its own https.Agent: neither axios's proxy-from-env nor a global agent applies.
    expect(seen.options?.agent).toBeInstanceOf(https.Agent);
    expect(seen.options?.agent).not.toBe(https.globalAgent);
    expect(seen.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a declared body above the cap before reading it', async () => {
    const { gateway, seen } = gatewayOn({
      headers: { 'content-length': String(TONCENTER_MAX_RESPONSE_BYTES + 1) },
      chunks: json({ ok: true }),
    });
    expect(await reasonOf(gateway.getBalance(ADDRESS))).toBe('MALFORMED');
    expect(seen.destroyed).toBe(true);
  });

  it('stops a streamed body at the cap (exactly at it is read, one byte more is not)', async () => {
    // A JSON answer padded with trailing blanks to exactly 64 bytes: read in full, then refused by
    // the codec (an odd shape); one byte more is cut off while streaming.
    const text = JSON.stringify({ ok: true, result: { odd: 1 } });
    const atCap = gatewayOn({ chunks: [Buffer.from(text.padEnd(64, ' '))] }, ENDPOINT, 64);
    expect(await reasonOf(atCap.gateway.getBalance(ADDRESS))).toBe('MALFORMED');
    expect(atCap.seen.destroyed).toBe(false);
    const over = gatewayOn(
      { chunks: [Buffer.from(text), Buffer.alloc(65 - text.length, 0x20)] },
      ENDPOINT,
      64,
    );
    expect(await reasonOf(over.gateway.getBalance(ADDRESS))).toBe('MALFORMED');
    expect(over.seen.destroyed).toBe(true);
  });

  it('follows no redirect: a 3xx is an error like any other non-2xx', async () => {
    const { gateway } = gatewayOn({
      status: 302,
      headers: { location: 'https://elsewhere.invalid/' },
      chunks: [],
    });
    expect(await reasonOf(gateway.getBalance(ADDRESS))).toBe('HTTP');
  });

  it('refuses a plain-http endpoint before any request', async () => {
    const { gateway, seen } = gatewayOn(
      { chunks: json({ ok: true }) },
      'http://toncenter.invalid/api/v2/jsonRPC',
    );
    expect(await reasonOf(gateway.getBalance(ADDRESS))).toBe('REFUSED');
    expect(seen.url).toBeNull();
  });

  it('a silent server ends at the deadline as TIMEOUT', async () => {
    const { gateway } = gatewayOn({ hang: true });
    expect(await reasonOf(gateway.getBalance(ADDRESS))).toBe('TIMEOUT');
  });
});

describe('the fresh connection (audit M-1 (b))', () => {
  it('normal reads share one kept-alive agent; every fresh read gets its own agent, no keep-alive', async () => {
    const { gateway, seen } = gatewayOn({ chunks: json({ ok: true, result: { odd: 1 } }) });
    await reasonOf(gateway.getAccountState(ADDRESS));
    await reasonOf(gateway.getAccountState(ADDRESS));
    const pooled = seen.agents.splice(0);
    const fresh = gateway.freshConnection();
    await reasonOf(fresh.getAccountState(ADDRESS));
    await reasonOf(fresh.getTransactions(ADDRESS, { limit: 1 }));
    const separate = seen.agents.splice(0);
    expect(pooled.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pooled).size).toBe(1);
    expect(Reflect.get(Object(pooled[0]), 'keepAlive')).toBe(true);
    expect(separate.length).toBeGreaterThanOrEqual(2);
    // A new agent per request: a new socket, never the one the normal reads keep alive.
    expect(new Set(separate).size).toBe(separate.length);
    for (const agent of separate) {
      expect(agent).toBeInstanceOf(https.Agent);
      expect(pooled).not.toContain(agent);
      expect(Reflect.get(Object(agent), 'keepAlive')).toBe(false);
    }
    // The key header goes with the fresh reads too.
    expect(JSON.stringify(seen.options?.headers)).toContain(API_KEY);
  });
});
