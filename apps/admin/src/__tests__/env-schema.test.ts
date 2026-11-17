import { describe, expect, it } from 'vitest';
import { MOCKS_IN_PRODUCTION_MESSAGE, parseAdminEnv } from '../env-schema';
import { isMockedWith } from '../lib/api/mock-groups';

const PROD = {
  VITE_API_URL: 'https://api.example.test/api/v1/',
  VITE_ENV_LABEL: 'PRODUCTION',
};

describe('admin env guard', () => {
  it('fills development defaults and strips the trailing slash', () => {
    expect(parseAdminEnv({}, { production: false })).toEqual({
      VITE_API_URL: 'http://localhost:5000/api/v1',
      VITE_ENV_LABEL: 'DEV',
      VITE_API_MOCKS: [],
    });
    expect(parseAdminEnv(PROD, { production: true }).VITE_API_URL).toBe(
      'https://api.example.test/api/v1',
    );
  });

  it('allows mock groups on the dev server', () => {
    const env = parseAdminEnv({ VITE_API_MOCKS: 'auth, confirmations' }, { production: false });
    expect(env.VITE_API_MOCKS).toEqual(['auth', 'confirmations']);
  });

  it('refuses any mock group in a production build', () => {
    expect(() => parseAdminEnv({ ...PROD, VITE_API_MOCKS: 'auth' }, { production: true })).toThrow(
      MOCKS_IN_PRODUCTION_MESSAGE,
    );
  });

  it('refuses an unknown mock group everywhere (a typo is not a silent no-op)', () => {
    expect(() => parseAdminEnv({ VITE_API_MOCKS: 'orderz' }, { production: false })).toThrow();
  });

  it('needs every value spelled out in production, and https for a remote API', () => {
    expect(() => parseAdminEnv({}, { production: true })).toThrow();
    expect(() =>
      parseAdminEnv({ ...PROD, VITE_API_URL: 'http://api.example.test' }, { production: true }),
    ).toThrow('https');
    expect(
      parseAdminEnv({ ...PROD, VITE_API_URL: 'http://localhost:5000/api/v1' }, { production: true })
        .VITE_API_URL,
    ).toBe('http://localhost:5000/api/v1');
  });

  it('refuses a base URL with a query, hash or credentials, and an unknown label', () => {
    for (const url of ['https://a.test/?x=1', 'https://a.test/#h', 'https://u:p@a.test']) {
      expect(() => parseAdminEnv({ VITE_API_URL: url }, { production: false }), url).toThrow();
    }
    expect(() => parseAdminEnv({ VITE_ENV_LABEL: 'QA' }, { production: false })).toThrow();
  });

  it('never routes to the mock in production, whatever the list says', () => {
    expect(isMockedWith('auth', { production: true, groups: ['auth'] })).toBe(false);
    expect(isMockedWith('auth', { production: false, groups: ['auth'] })).toBe(true);
    expect(isMockedWith('auth', { production: false, groups: [] })).toBe(false);
    expect(isMockedWith(undefined, { production: false, groups: ['auth'] })).toBe(false);
  });
});
