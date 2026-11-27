import { inspect } from 'node:util';
import { Address } from '@ton/core';
import type { TonClientParameters } from '@ton/ton';
import { TonApiKey } from '../../config/ton-api-key';
import { TonGatewayError } from '../ton-gateway';
import { TonHttpError, TonHttpStatusError } from '../toncenter-http';
import { ToncenterGateway } from '../toncenter.gateway';

// The real gateway is driven through TonClient's own `httpAdapter` seam: no request leaves the
// process. What matters here is that nothing of the request (the X-API-Key header) or of the
// response body ever reaches an error message (redaction, plan §11).

type Adapter = NonNullable<TonClientParameters['httpAdapter']>;
type AdapterConfig = Parameters<Adapter>[0];

// Assembled at run time: a recognisable marker, not a credential.
const API_KEY = ['marker', 'for', 'toncenter', 'tests'].join('-');
const BODY_MARKER = 'response-body-marker';
const ADDRESS = new Address(0, Buffer.alloc(32, 5));

function gatewayWith(answer: (config: AdapterConfig) => Promise<Awaited<ReturnType<Adapter>>>) {
  const headers: string[] = [];
  const adapter: Adapter = (config) => {
    headers.push(JSON.stringify(config.headers));
    return answer(config);
  };
  const gateway = new ToncenterGateway({
    endpoint: 'https://toncenter.invalid/api/v2/jsonRPC',
    apiKey: new TonApiKey(API_KEY),
    dryRun: false,
    httpAdapter: adapter,
  });
  return { gateway, headers };
}

const ok = (config: AdapterConfig, data: unknown) =>
  Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config });

async function failureOf(promise: Promise<unknown>): Promise<TonGatewayError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof TonGatewayError)) throw new Error('expected a TonGatewayError');
  const text = `${error.message} ${inspect(error)} ${JSON.stringify(error)} ${String(error.stack)}`;
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(BODY_MARKER);
  return error;
}

describe('ToncenterGateway (DRY_RUN=false only)', () => {
  it('is never built in a dry run', () => {
    expect(
      () => new ToncenterGateway({ endpoint: 'https://toncenter.invalid', dryRun: true }),
    ).toThrow('never built with FULFILLMENT_DRY_RUN=true');
  });

  it('maps getAddressInformation into one state snapshot; the TonClient never holds the key', async () => {
    // The answer in the shape @ton/ton's own codec accepts (toncenter v2 getAddressInformation).
    const lastHash = Buffer.alloc(32, 0xab);
    const info = {
      balance: '1234567890',
      state: 'active',
      data: Buffer.from([1, 2, 3]).toString('base64'),
      code: '',
      last_transaction_id: {
        '@type': 'internal.transactionId',
        lt: '4700000000001',
        hash: lastHash.toString('base64'),
      },
      block_id: {
        '@type': 'ton.blockIdExt',
        workchain: -1,
        shard: '-9223372036854775808',
        seqno: 42,
        root_hash: '',
        file_hash: '',
      },
      sync_utime: 1_800_000_000,
    };
    const { gateway, headers } = gatewayWith((config) => ok(config, { ok: true, result: info }));
    expect(await gateway.getBalance(ADDRESS)).toBe(1_234_567_890n);
    expect(await gateway.getAccountState(ADDRESS)).toEqual({
      status: 'active',
      balanceNano: 1_234_567_890n,
      data: Buffer.from([1, 2, 3]),
      chainTime: 1_800_000_000,
      lastTx: { lt: 4_700_000_000_001n, hash: lastHash.toString('hex') },
    });
    // The key is set by the bounded transport (toncenter-http.spec.ts), never by the TonClient
    // (review m5): an injected adapter sees a request config without it.
    expect(headers.join(' ')).not.toContain(API_KEY);
  });

  it('an HTTP error carrying the request and the body becomes HTTP, without either', async () => {
    const { gateway } = gatewayWith((config) =>
      Promise.reject(
        Object.assign(new Error(`Request failed ${BODY_MARKER} ${API_KEY}`), {
          config,
          response: { status: 502, data: BODY_MARKER, headers: {}, config },
        }),
      ),
    );
    const error = await failureOf(gateway.getBalance(ADDRESS));
    expect([error.operation, error.reason]).toEqual(['getBalance', 'HTTP']);
  });

  it('a JSON-RPC refusal, a bad shape, a timeout and a network error are told apart', async () => {
    const refused = gatewayWith((config) => ok(config, { ok: false, error: BODY_MARKER }));
    expect((await failureOf(refused.gateway.sendBoc(Buffer.alloc(8)))).reason).toBe('REFUSED');
    const malformed = gatewayWith((config) =>
      ok(config, { ok: true, result: { odd: BODY_MARKER } }),
    );
    expect((await failureOf(malformed.gateway.getBalance(ADDRESS))).reason).toBe('MALFORMED');
    const slow = gatewayWith(() =>
      Promise.reject(Object.assign(new Error(API_KEY), { code: 'ECONNABORTED' })),
    );
    expect((await failureOf(slow.gateway.getBalance(ADDRESS))).reason).toBe('TIMEOUT');
    const down = gatewayWith(() => Promise.reject(new Error(`connect ECONNREFUSED ${API_KEY}`)));
    expect((await failureOf(down.gateway.getAccountState(ADDRESS))).reason).toBe('NETWORK');
  });

  // Review M1 / audit M2: the lookup is fail-closed. Only toncenter's own "not found" answer
  // (HTTP 404 with ok:false; TAXMIN, the shape is pinned by the S9/S12 recorded fixture) is "not
  // visible"; anything else is a gateway error, which the reader turns into a WAIT.
  const statusAnswer = (status: number, body: unknown) =>
    gatewayWith(() => Promise.reject(new TonHttpStatusError(status, JSON.stringify(body))));

  it('the result lookup: only 404 with ok:false is "not found"', async () => {
    const notFound = statusAnswer(404, { ok: false, error: BODY_MARKER, code: 404 });
    expect(await notFound.gateway.findResultTx(ADDRESS, ADDRESS, 10n)).toBeNull();
  });

  it.each([429, 500, 502, 503])(
    'the result lookup: HTTP %i is an error, never "not found"',
    async (status) => {
      const { gateway } = statusAnswer(status, { ok: false, error: BODY_MARKER, code: status });
      const error = await failureOf(gateway.findResultTx(ADDRESS, ADDRESS, 10n));
      expect([error.operation, error.reason]).toEqual(['findResultTx', 'HTTP']);
    },
  );

  it('the result lookup: a 404 without ok:false, a timeout, a bad shape, a cut body are errors', async () => {
    const plain404 = gatewayWith(() => Promise.reject(new TonHttpStatusError(404, BODY_MARKER)));
    expect((await failureOf(plain404.gateway.findResultTx(ADDRESS, ADDRESS, 1n))).reason).toBe(
      'HTTP',
    );
    const slow = gatewayWith(() => Promise.reject(new TonHttpError('ECONNABORTED')));
    expect((await failureOf(slow.gateway.findResultTx(ADDRESS, ADDRESS, 1n))).reason).toBe(
      'TIMEOUT',
    );
    const odd = gatewayWith((config) => ok(config, { ok: true, result: { odd: BODY_MARKER } }));
    expect((await failureOf(odd.gateway.findResultTx(ADDRESS, ADDRESS, 1n))).reason).toBe(
      'MALFORMED',
    );
    const huge = gatewayWith(() => Promise.reject(new TonHttpError('ERR_RESPONSE_TOO_LARGE')));
    expect((await failureOf(huge.gateway.findResultTx(ADDRESS, ADDRESS, 1n))).reason).toBe(
      'MALFORMED',
    );
    const down = gatewayWith(() => Promise.reject(new Error(`ECONNRESET ${API_KEY}`)));
    expect((await failureOf(down.gateway.findResultTx(ADDRESS, ADDRESS, 1n))).reason).toBe(
      'NETWORK',
    );
  });
});
