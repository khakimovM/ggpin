import { describe, expect, it } from 'vitest';
import { parseServerEnv, resolveApiBaseUrl } from './server-env';

const PUBLIC_API = 'https://api.example.test/api/v1';

describe('parseServerEnv', () => {
  it('treats an unset or blank API_INTERNAL_URL as "not configured"', () => {
    expect(parseServerEnv({}).API_INTERNAL_URL).toBe('');
    expect(parseServerEnv({ API_INTERNAL_URL: '' }).API_INTERNAL_URL).toBe('');
    expect(parseServerEnv({ API_INTERNAL_URL: '   ' }).API_INTERNAL_URL).toBe('');
  });

  it('accepts an internal http URL and drops the trailing slash', () => {
    expect(parseServerEnv({ API_INTERNAL_URL: 'http://api:5000/api/v1/' }).API_INTERNAL_URL).toBe(
      'http://api:5000/api/v1',
    );
  });

  it.each([
    'not a url',
    'ftp://api:5000/api/v1',
    'javascript:alert(1)',
    'http://api:5000/api/v1?x=1',
    'http://api:5000/api/v1#frag',
    // Credentials in the URL; `user:pass@host` is the placeholder the gitleaks allowlist knows.
    'http://user:pass@host:5000/api/v1',
  ])('rejects %s', (value) => {
    expect(() => parseServerEnv({ API_INTERNAL_URL: value })).toThrow();
  });
});

describe('resolveApiBaseUrl', () => {
  it('falls back to the public API URL when the internal one is not set', () => {
    expect(resolveApiBaseUrl({}, PUBLIC_API)).toBe(PUBLIC_API);
  });

  it('prefers the internal URL when it is set', () => {
    expect(resolveApiBaseUrl({ API_INTERNAL_URL: 'http://api:5000/api/v1' }, PUBLIC_API)).toBe(
      'http://api:5000/api/v1',
    );
  });

  it('throws on a bad value instead of quietly using the public URL', () => {
    expect(() => resolveApiBaseUrl({ API_INTERNAL_URL: 'nope' }, PUBLIC_API)).toThrow();
  });
});
