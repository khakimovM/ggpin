import { afterEach, describe, expect, it, vi } from 'vitest';
import E2eProbeErrorPage from '../[locale]/e2e-probe/error/page';
import E2eMarketingProbeErrorPage from '../[locale]/(marketing)/e2e-probe-error/page';

// The e2e-only pages that throw on purpose must be a 404 in every real build: they open only when
// the e2e web server sets E2E_PROBES=1 (the same switch as the token probe and the gallery).
const PAGES = [
  ['e2e-probe/error', E2eProbeErrorPage],
  ['(marketing)/e2e-probe-error', E2eMarketingProbeErrorPage],
] as const;

const params = Promise.resolve({ locale: 'uz' });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(PAGES)('%s', (_name, Page) => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1'])(
    'answers 404 when E2E_PROBES is %j',
    async (value) => {
      vi.stubEnv('E2E_PROBES', value);
      // notFound() throws Next's not-found error (digest NEXT_HTTP_ERROR_FALLBACK;404).
      await expect(Page({ params })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    },
  );

  it('throws its own error, not a 404, when E2E_PROBES is 1', async () => {
    vi.stubEnv('E2E_PROBES', '1');
    await expect(Page({ params })).rejects.toThrow('e2e probe: render failure');
  });
});
