// Phase 4 S0 spike helpers. Throwaway code on branch spike/p4-mtcute, never merged to main.
// Output discipline: only field names, types, booleans and counts are printed. Never ids, phones,
// names, message text, session strings or credentials.
import { readFileSync } from 'node:fs';
import { spikeCredentialsPath } from '../config/spike-env';

export type SafeValue = boolean | number | null | readonly string[];

export function out(key: string, value: SafeValue | `type:${string}` | `const:${string}`): void {
  process.stdout.write(`${key} = ${JSON.stringify(value)}\n`);
}

/** Error summary without the message (mtcute messages may contain a phone number). */
export function errCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const text = (e as { text?: unknown }).text;
    if (typeof text === 'string') return `rpc:${text.replace(/[0-9]+/g, 'N')}`;
    return `class:${e.constructor.name}`;
  }
  return `type:${typeof e}`;
}

export interface TestCredentials {
  apiId: number;
  apiHash: string;
}

export function loadCredentials(): TestCredentials {
  const parsed: unknown = JSON.parse(readFileSync(spikeCredentialsPath(), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('credentials: not an object');
  const apiId = (parsed as { api_id?: unknown }).api_id;
  const apiHash = (parsed as { api_hash?: unknown }).api_hash;
  if (typeof apiId !== 'number' || !Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('credentials: api_id must be a positive integer');
  }
  if (typeof apiHash !== 'string' || !/^[0-9a-f]{32}$/i.test(apiHash)) {
    throw new Error('credentials: api_hash must be 32 hex chars');
  }
  return { apiId, apiHash };
}

export function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with the first value matching `pred` pushed via the returned `push`, or null on timeout. */
export function waiter<T>(pred: (v: T) => boolean, timeoutMs: number) {
  let done: ((v: T | null) => void) | undefined;
  const promise = new Promise<T | null>((resolve) => {
    done = resolve;
    setTimeout(() => resolve(null), timeoutMs);
  });
  return {
    promise,
    push(v: T): void {
      if (done && pred(v)) {
        done(v);
        done = undefined;
      }
    },
  };
}
