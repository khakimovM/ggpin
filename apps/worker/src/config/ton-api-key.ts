import { inspect } from 'node:util';

// TON_API_KEY in the frozen WORKER_CONFIG (review m5, audit I-3). The config lives as long as the
// process and is injected into many services, so the key is not a plain string there: it is this
// holder, which prints and serializes as a placeholder. The one reader is the toncenter transport
// (toncenter-http.ts), which puts it into the X-API-Key header of each request itself; the
// TonClient never receives it, so it is not in that client's parameters or request config either.

export class TonApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** For toncenter-http.ts only: the X-API-Key header value of one request. */
  headerValueForToncenter(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'TonApiKey([redacted])';
  }
}
