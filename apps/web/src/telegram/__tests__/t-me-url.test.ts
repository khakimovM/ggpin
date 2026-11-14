import { describe, expect, it } from 'vitest';
import { configuredTelegramUrl } from '../t-me-url';

describe('configuredTelegramUrl (audit L-2, L-3)', () => {
  it.each([
    ['https://t.me/ggpin_channel', 'https://t.me/ggpin_channel'],
    ['https://T.ME/x', 'https://t.me/x'],
    ['HTTPS://t.me/ggpin_support', 'https://t.me/ggpin_support'],
    ['https://t.me/+AbCdEf123', 'https://t.me/+AbCdEf123'],
    ['https://t.me/joinchat/AAAA-b_c', 'https://t.me/joinchat/AAAA-b_c'],
  ])('%s is normalised to %s', (input, href) => {
    expect(configuredTelegramUrl(input)).toBe(href);
  });

  it.each([
    'http://t.me/x',
    'https://t.me',
    'https://t.me/',
    'https://t.me:8443/x',
    'https://t.me:443x/x',
    'https://user@t.me/x',
    'https://user:pw@t.me/x',
    'https://t.me/x?start=1',
    'https://t.me/x?',
    'https://t.me/x#frag',
    'https://t.me/x#',
    'https://t.me/"onmouseover=alert(1)',
    'https://t.me/x%20y',
    'https://t.me/x y',
    'https://t.me.evil.example/x',
    'https://evil.example/t.me/x',
    'https://telegram.me/x',
    'javascript:alert(1)',
    '//t.me/x',
    't.me/x',
    'not a url',
    '',
  ])('rejects %s', (input) => {
    expect(configuredTelegramUrl(input)).toBeNull();
  });
});
