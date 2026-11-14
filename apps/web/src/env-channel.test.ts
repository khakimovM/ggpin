import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './env-schema';

const valid = {
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'example_bot',
};

describe.each(['NEXT_PUBLIC_TELEGRAM_CHANNEL_URL', 'NEXT_PUBLIC_SUPPORT_URL'] as const)(
  '%s',
  (name) => {
    const parse = (value: string | undefined) =>
      parseClientEnv({ ...valid, [name]: value }, { production: true })[name];

    it('is optional: unset or empty means "no link"', () => {
      expect(parse(undefined)).toBe('');
      expect(parse('')).toBe('');
    });

    it.each([
      'https://t.me/ggpin_channel',
      'https://t.me/+AbCdEf123',
      'https://t.me/joinchat/AAAA',
    ])('accepts %s', (url) => {
      expect(parse(url)).toBe(url);
    });

    it('is normalised once, here: https://T.ME/x becomes https://t.me/x (audit L-2)', () => {
      expect(parse('https://T.ME/x')).toBe('https://t.me/x');
      expect(parse('HTTPS://t.me/ggpin_support')).toBe('https://t.me/ggpin_support');
    });

    it.each([
      'http://t.me/ggpin_channel',
      'https://t.me',
      'https://t.me/',
      'https://t.me/x?start=1',
      'https://t.me/x#frag',
      'https://evil.example/ggpin_channel',
      'https://t.me.evil.example/x',
      'https://user@t.me/x',
      'https://user:pw@t.me/x',
      'https://t.me:8443/x',
      'https://t.me/x?',
      'https://t.me/"onmouseover=alert(1)',
      'https://help.example.test/ggpin',
      'javascript:alert(1)',
      'not a url',
    ])('rejects %s', (url) => {
      expect(() => parse(url)).toThrow();
    });
  },
);
