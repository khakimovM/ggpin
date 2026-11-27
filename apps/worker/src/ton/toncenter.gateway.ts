import type { Address, Transaction } from '@ton/core';
import { TonClient, type TonClientParameters } from '@ton/ton';
import type { TonApiKey } from '../config/ton-api-key';
import {
  TonGatewayError,
  type TonAccountState,
  type TonChainWitness,
  type TonGateway,
  type TonGatewayOperation,
  type TxPage,
} from './ton-gateway';
import { boundedHttpsAdapter, type BoundedHttpOptions } from './toncenter-http';

// The real chain through toncenter's HTTP API (`@ton/ton` TonClient). Built ONLY when
// FULFILLMENT_DRY_RUN=false (the constructor refuses otherwise, and the module factory never asks
// for it in a dry run). Every error is replaced by a TonGatewayError that names the operation and
// a coarse reason: the HTTP client's errors carry the request config (the X-API-Key header) and
// the response body, which must never reach a log. The transport is boundedHttpsAdapter (https
// only, 2 MiB, no redirects, no proxy) unless a test injects its own adapter. It sets the API key
// header from the TonApiKey holder; the TonClient never gets the key (review m5, audit I-3).
//
// Two clients: the pooled one (keep-alive) for every call, and a fresh one whose transport opens a
// new socket per request, used only by freshConnection() for the reads that confirm an EXPIRY
// observation (audit M-1 (b): a kept-alive connection sticks to one, possibly lagging, node).

export interface ToncenterOptions {
  readonly endpoint: string;
  readonly apiKey?: TonApiKey | undefined;
  readonly dryRun: boolean;
  readonly timeoutMs?: number;
  /** Tests only: an HTTP adapter that answers without a network (replaces the bounded one). */
  readonly httpAdapter?: TonClientParameters['httpAdapter'];
  /** Tests only: the bounded transport's request function and size cap (no network). */
  readonly transport?: Pick<BoundedHttpOptions, 'request' | 'maxBytes'>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

/**
 * toncenter's "no such transaction" answer to tryLocateResultTx: HTTP 404 with a JSON-RPC body
 * `{ ok: false }`. TAXMIN (a guess): no recorded toncenter answer exists yet; the fixture is
 * recorded in S9/S12 (S9 fixture bilan aniqlanadi). Until then anything else is an error, so a
 * 429, a 5xx, a timeout or a body we cannot read waits (fail-closed) instead of reading as
 * "not visible", which the grace period would turn into a delivery (review M1, audit M2).
 */
export function isToncenterNotFound(error: unknown): boolean {
  const response = field(error, 'response');
  return field(response, 'status') === 404 && field(field(response, 'data'), 'ok') === false;
}

/** A coarse reason read from the error's shape; the message text never travels. */
function reasonOf(error: unknown): TonGatewayError['reason'] {
  const code = field(error, 'code');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ERR_RESPONSE_TOO_LARGE' || code === 'ERR_BAD_BODY') return 'MALFORMED';
  if (code === 'ERR_NOT_HTTPS') return 'REFUSED';
  if (typeof field(field(error, 'response'), 'status') === 'number') return 'HTTP';
  // HttpApi throws plain Errors with fixed prefixes for a JSON-RPC refusal and a bad shape.
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Received error')) return 'REFUSED';
  if (message.startsWith('Malformed response')) return 'MALFORMED';
  return 'NETWORK';
}

async function call<T>(operation: TonGatewayOperation, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new TonGatewayError(operation, reasonOf(error));
  }
}

async function accountStateVia(client: TonClient, address: Address): Promise<TonAccountState> {
  const state = await call('getAccountState', () => client.getContractState(address));
  const last = state.lastTransaction;
  return {
    status: state.state,
    balanceNano: state.balance,
    data: state.data,
    chainTime: state.timestampt,
    // toncenter v2 spells hashes in base64; the module compares lowercase hex.
    lastTx:
      last === null
        ? null
        : { lt: BigInt(last.lt), hash: Buffer.from(last.hash, 'base64').toString('hex') },
  };
}

function transactionsVia(
  client: TonClient,
  address: Address,
  page: TxPage,
): Promise<readonly Transaction[]> {
  const at = page.at;
  return call('getTransactions', () =>
    client.getTransactions(address, {
      limit: page.limit,
      // inclusive: the page starts AT that transaction (HttpApi then neither asks for one more
      // nor drops the first), so the scan can check it is the one the state named.
      ...(at === undefined
        ? {}
        : {
            lt: at.lt.toString(),
            hash: Buffer.from(at.hash, 'hex').toString('base64'),
            inclusive: true,
          }),
    }),
  );
}

export class ToncenterGateway implements TonGateway {
  readonly #client: TonClient;
  readonly #freshClient: TonClient;

  constructor(options: ToncenterOptions) {
    if (options.dryRun) {
      throw new Error('ToncenterGateway is never built with FULFILLMENT_DRY_RUN=true');
    }
    const clientOf = (fresh: boolean) =>
      new TonClient({
        endpoint: options.endpoint,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        httpAdapter:
          options.httpAdapter ??
          boundedHttpsAdapter({ ...options.transport, apiKey: options.apiKey, fresh }),
      });
    this.#client = clientOf(false);
    this.#freshClient = clientOf(true);
  }

  getAccountState(address: Address): Promise<TonAccountState> {
    return accountStateVia(this.#client, address);
  }

  getBalance(address: Address): Promise<bigint> {
    return call('getBalance', () => this.#client.getBalance(address));
  }

  sendBoc(boc: Buffer): Promise<void> {
    return call('sendBoc', () => this.#client.sendFile(boc));
  }

  getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    return transactionsVia(this.#client, address, page);
  }

  /** The two reads over the client whose every request opens a new socket (audit M-1 (b)). */
  freshConnection(): TonChainWitness {
    const client = this.#freshClient;
    return {
      getAccountState: (address) => accountStateVia(client, address),
      getTransactions: (address, page) => transactionsVia(client, address, page),
    };
  }

  async findResultTx(
    source: Address,
    destination: Address,
    createdLt: bigint,
  ): Promise<Transaction | null> {
    try {
      return await this.#client.tryLocateResultTx(source, destination, createdLt.toString());
    } catch (error) {
      if (isToncenterNotFound(error)) return null;
      throw new TonGatewayError('findResultTx', reasonOf(error));
    }
  }
}
