import { afterEach, describe, expect, it, vi } from 'vitest';

// `env.ts` is what the app imports; next.config.ts deliberately uses env-schema only. These
// tests prove the guard is wired to the module that runs during `next build`.
function stubEnv(nodeEnv: string, mocks: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test/api/v1');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.test');
  vi.stubEnv('NEXT_PUBLIC_BOT_USERNAME', 'example_bot');
  vi.stubEnv('NEXT_PUBLIC_API_MOCKS', mocks);
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_URL', '');
  vi.resetModules();
}

describe('env module', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws on import in production when any mock group is enabled', async () => {
    stubEnv('production', 'orders');
    await expect(import('./env')).rejects.toThrow(/NEXT_PUBLIC_API_MOCKS must be empty/);
  });

  it('imports in production when mocks are empty', async () => {
    stubEnv('production', '');
    const { env } = await import('./env');
    expect(env.NEXT_PUBLIC_API_MOCKS).toEqual([]);
  });

  it('allows mocks outside production', async () => {
    stubEnv('development', 'quotes,orders');
    const { env } = await import('./env');
    expect(env.NEXT_PUBLIC_API_MOCKS).toEqual(['quotes', 'orders']);
  });
});
