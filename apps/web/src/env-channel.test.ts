import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './env-schema';

const valid = {
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'example_bot',
};

describe('NEXT_PUBLIC_TELEGRAM_CHANNEL_URL', () => {
  const parse = (value: string | undefined) =>
    parseClientEnv({ ...valid, NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: value }, { production: true });

  it('is optional: unset or empty means "no channel link"', () => {
    expect(parse(undefined).NEXT_PUBLIC_TELEGRAM_CHANNEL_URL).toBe('');
    expect(parse('').NEXT_PUBLIC_TELEGRAM_CHANNEL_URL).toBe('');
  });

  it.each(['https://t.me/ggpin_channel', 'https://t.me/+AbCdEf123', 'https://t.me/joinchat/AAAA'])(
    'accepts %s',
    (url) => {
      expect(parse(url).NEXT_PUBLIC_TELEGRAM_CHANNEL_URL).toBe(url);
    },
  );

  it.each([
    'http://t.me/ggpin_channel',
    'https://t.me',
    'https://t.me/',
    'https://t.me/x?start=1',
    'https://t.me/x#frag',
    'https://evil.example/ggpin_channel',
    'https://t.me.evil.example/x',
    'https://user@t.me/x',
    'https://t.me:8443/x',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => parse(url)).toThrow();
  });
});
