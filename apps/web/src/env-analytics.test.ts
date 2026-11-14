import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './env-schema';

// NEXT_PUBLIC_ANALYTICS_SITE_ID (phase 8 S5): empty = analytics off; otherwise a UUID only, because
// the value is written into a script attribute on every marketing page.
const valid = {
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'example_bot',
};

const parse = (value: string | undefined, production = true) =>
  parseClientEnv({ ...valid, NEXT_PUBLIC_ANALYTICS_SITE_ID: value }, { production })
    .NEXT_PUBLIC_ANALYTICS_SITE_ID;

describe('NEXT_PUBLIC_ANALYTICS_SITE_ID', () => {
  it.each([true, false])('is off when unset or empty (production: %s)', (production) => {
    expect(parse(undefined, production)).toBe('');
    expect(parse('', production)).toBe('');
  });

  it.each([
    '94db1cb1-74f4-4a40-ad6c-962362670409', // v4, the Umami default
    '019a7c2e-5b1d-7f3a-8c4e-2d6f8a0b1c3e', // v7 (Umami with USE_UUIDV7)
  ])('accepts the Umami website id %s', (id) => {
    expect(parse(id)).toBe(id);
  });

  it.each([
    'abc',
    'ggpin',
    ' 94db1cb1-74f4-4a40-ad6c-962362670409',
    '94db1cb1-74f4-4a40-ad6c-962362670409 ',
    '94db1cb174f44a40ad6c962362670409',
    '94db1cb1-74f4-4a40-ad6c-96236267040',
    '{94db1cb1-74f4-4a40-ad6c-962362670409}',
    '94db1cb1-74f4-4a40-ad6c-96236267040g',
    'https://stats.example.test/script.js',
    '"><script>alert(1)</script>',
  ])('rejects %j', (id) => {
    expect(() => parse(id)).toThrow();
    expect(() => parse(id, false)).toThrow();
  });
});
