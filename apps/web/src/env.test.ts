import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './env-schema';

const valid = {
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'example_bot',
};

describe('parseClientEnv', () => {
  it('accepts a complete production environment with no mocks', () => {
    const env = parseClientEnv(valid, { production: true });
    expect(env.NEXT_PUBLIC_API_MOCKS).toEqual([]);
    expect(env.NEXT_PUBLIC_SUPPORT_URL).toBe('');
  });

  it('rejects an invalid URL', () => {
    expect(() =>
      parseClientEnv({ ...valid, NEXT_PUBLIC_API_URL: 'not a url' }, { production: true }),
    ).toThrow();
  });

  it('rejects an invalid bot username', () => {
    expect(() =>
      parseClientEnv({ ...valid, NEXT_PUBLIC_BOT_USERNAME: 'x' }, { production: true }),
    ).toThrow();
  });

  it('requires every URL in production (no silent dev defaults)', () => {
    expect(() => parseClientEnv({}, { production: true })).toThrow();
  });

  it('falls back to local defaults outside production', () => {
    const env = parseClientEnv({}, { production: false });
    expect(env.NEXT_PUBLIC_API_URL).toBe('http://localhost:5000/api/v1');
  });

  it('allows a mock list outside production', () => {
    const env = parseClientEnv(
      { ...valid, NEXT_PUBLIC_API_MOCKS: 'wallet, orders' },
      { production: false },
    );
    expect(env.NEXT_PUBLIC_API_MOCKS).toEqual(['wallet', 'orders']);
  });

  it('fails a production build when any mock group is enabled', () => {
    expect(() =>
      parseClientEnv({ ...valid, NEXT_PUBLIC_API_MOCKS: 'wallet' }, { production: true }),
    ).toThrow(/NEXT_PUBLIC_API_MOCKS must be empty/);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://api.example.test/v1'])(
    'rejects the non-http(s) URL %s',
    (url) => {
      for (const production of [true, false]) {
        expect(() =>
          parseClientEnv({ ...valid, NEXT_PUBLIC_API_URL: url }, { production }),
        ).toThrow();
        expect(() =>
          parseClientEnv({ ...valid, NEXT_PUBLIC_SITE_URL: url }, { production }),
        ).toThrow();
        expect(() =>
          parseClientEnv({ ...valid, NEXT_PUBLIC_SUPPORT_URL: url }, { production }),
        ).toThrow();
      }
    },
  );

  it('requires https in production for every non-local URL', () => {
    expect(() =>
      parseClientEnv(
        { ...valid, NEXT_PUBLIC_API_URL: 'http://api.example.test' },
        { production: true },
      ),
    ).toThrow(/NEXT_PUBLIC_API_URL must use https/);
    expect(() =>
      parseClientEnv(
        { ...valid, NEXT_PUBLIC_SITE_URL: 'http://example.test' },
        { production: true },
      ),
    ).toThrow(/NEXT_PUBLIC_SITE_URL must use https/);
    expect(() =>
      parseClientEnv({ ...valid, NEXT_PUBLIC_SUPPORT_URL: 'http://t.me/op' }, { production: true }),
    ).toThrow(/NEXT_PUBLIC_SUPPORT_URL must use https/);
  });

  it('allows plain http in production only for a local host (e2e on localhost)', () => {
    const env = parseClientEnv(
      {
        ...valid,
        NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
        NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3100',
      },
      { production: true },
    );
    expect(env.NEXT_PUBLIC_API_URL).toBe('http://localhost:5000/api/v1');
  });

  it('accepts https URLs in production, including the support link', () => {
    const env = parseClientEnv(
      { ...valid, NEXT_PUBLIC_SUPPORT_URL: 'https://t.me/operator' },
      { production: true },
    );
    expect(env.NEXT_PUBLIC_SUPPORT_URL).toBe('https://t.me/operator');
  });

  it.each(['ggpin', 'example_channel', 'bot', '1example_bot', 'a_b_bot_x'])(
    'rejects the bot username %s (must be 5-32 chars, start with a letter, end with "bot")',
    (name) => {
      expect(() =>
        parseClientEnv({ ...valid, NEXT_PUBLIC_BOT_USERNAME: name }, { production: true }),
      ).toThrow();
    },
  );

  it.each(['ggpin_bot', 'GGPinBot', 'Example_BOT', 'a_bot'])(
    'accepts the bot username %s',
    (name) => {
      const env = parseClientEnv(
        { ...valid, NEXT_PUBLIC_BOT_USERNAME: name },
        { production: true },
      );
      expect(env.NEXT_PUBLIC_BOT_USERNAME).toBe(name);
    },
  );

  it('rejects an unknown mock group', () => {
    expect(() =>
      parseClientEnv({ ...valid, NEXT_PUBLIC_API_MOCKS: 'nope' }, { production: false }),
    ).toThrow();
  });
});
