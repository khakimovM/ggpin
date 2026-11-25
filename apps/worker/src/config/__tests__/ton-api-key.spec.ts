import { format, inspect } from 'node:util';
import { loadEnv } from '../env';
import { TonApiKey } from '../ton-api-key';
import { TEST_ENV_SOURCE } from './test-env';
import { TEST_TON_API_KEY, tonLiveSource } from './ton-live-env';

// TON_API_KEY in the frozen worker config (review m5, audit I-3): a holder that prints, serializes
// and inspects as a placeholder; only the toncenter transport reads the value (lint-enforced).

describe('TonApiKey', () => {
  const key = new TonApiKey(TEST_TON_API_KEY);

  it('never shows the value: JSON, String, template, inspect, format, a log line', () => {
    const shown = [
      JSON.stringify(key),
      JSON.stringify({ apiKey: key }),
      String(key),
      `${key.toString()}`,
      inspect(key),
      inspect({ nested: { key } }, { depth: 5, showHidden: true }),
      format('%s %o %O %j', key, key, key, { key }),
    ];
    for (const text of shown) expect(text).not.toContain(TEST_TON_API_KEY);
    expect(JSON.stringify({ apiKey: key })).toBe('{"apiKey":"[redacted]"}');
    expect(inspect(key)).toBe('TonApiKey([redacted])');
  });

  it('has no enumerable or own string property holding the value', () => {
    expect(Object.keys(key)).toEqual([]);
    expect(Object.getOwnPropertyNames(key)).toEqual([]);
    expect(Object.values(key)).toEqual([]);
  });

  it('gives the value to the toncenter transport only, by its one method', () => {
    expect(key.headerValueForToncenter()).toBe(TEST_TON_API_KEY);
  });
});

describe('the worker config holds TON_API_KEY as a TonApiKey', () => {
  it('a live config: the holder, and the config never prints the key', () => {
    const config = loadEnv({
      ...TEST_ENV_SOURCE,
      ...tonLiveSource(),
      FULFILLMENT_DRY_RUN: 'false',
    });
    expect(config.TON_API_KEY).toBeInstanceOf(TonApiKey);
    expect(config.TON_API_KEY?.headerValueForToncenter()).toBe(TEST_TON_API_KEY);
    const bigintAsText = (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value;
    expect(JSON.stringify(config, bigintAsText)).not.toContain(TEST_TON_API_KEY);
    expect(inspect(config, { depth: 10, showHidden: true })).not.toContain(TEST_TON_API_KEY);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('a dry run drops it', () => {
    const config = loadEnv({ ...TEST_ENV_SOURCE, TON_API_KEY: TEST_TON_API_KEY });
    expect(config.TON_API_KEY).toBeUndefined();
  });
});
