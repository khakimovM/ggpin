import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseClientEnv } from '../../../env-schema';
import { isMockedWith } from '../mock-groups';

describe('isMockedWith', () => {
  it('mocks only the groups on the list, outside production', () => {
    const source = { production: false, groups: ['wallet', 'payments'] } as const;
    expect(isMockedWith('wallet', source)).toBe(true);
    expect(isMockedWith('payments', source)).toBe(true);
    expect(isMockedWith('orders', source)).toBe(false);
    expect(isMockedWith(undefined, source)).toBe(false);
  });

  it('is always false in production, whatever the list says', () => {
    expect(isMockedWith('wallet', { production: true, groups: ['wallet'] })).toBe(false);
  });
});

describe('production guard', () => {
  const PROD_ENV = {
    NEXT_PUBLIC_API_URL: 'https://api.ggpin.uz/api/v1',
    NEXT_PUBLIC_SITE_URL: 'https://ggpin.uz',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
  };

  it('a production env with a mock list is refused', () => {
    expect(() =>
      parseClientEnv({ ...PROD_ENV, NEXT_PUBLIC_API_MOCKS: 'wallet' }, { production: true }),
    ).toThrow(/NEXT_PUBLIC_API_MOCKS/);
  });

  it('a production env with an empty list is accepted', () => {
    expect(() =>
      parseClientEnv({ ...PROD_ENV, NEXT_PUBLIC_API_MOCKS: '' }, { production: true }),
    ).not.toThrow();
  });

  describe('through the real modules', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    function stubProduction(mocks: string): void {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_API_URL', PROD_ENV.NEXT_PUBLIC_API_URL);
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', PROD_ENV.NEXT_PUBLIC_SITE_URL);
      vi.stubEnv('NEXT_PUBLIC_BOT_USERNAME', PROD_ENV.NEXT_PUBLIC_BOT_USERNAME);
      vi.stubEnv('NEXT_PUBLIC_API_MOCKS', mocks);
      vi.resetModules();
    }

    it('isMocked is false in production for every group', async () => {
      stubProduction('');
      const { isMocked, MOCK_GROUP_NAMES } = await import('../mock-groups');
      for (const group of MOCK_GROUP_NAMES) expect(isMocked(group)).toBe(false);
    });

    it('the app refuses to load with mocks configured in production', async () => {
      stubProduction('wallet,payments');
      await expect(import('../mock-groups')).rejects.toThrow(/NEXT_PUBLIC_API_MOCKS/);
    });

    it('outside production the configured groups are mocked', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_API_MOCKS', 'wallet');
      vi.resetModules();
      const { isMocked } = await import('../mock-groups');
      expect(isMocked('wallet')).toBe(true);
      expect(isMocked('orders')).toBe(false);
    });
  });
});
