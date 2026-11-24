import { afterEach, describe, expect, it, vi } from 'vitest';
import E2eProbeErrorPage from '../[locale]/e2e-probe/error/page';
import E2eMarketingProbeErrorPage from '../[locale]/(marketing)/e2e-probe-error/page';
import { GET as statsScript } from '../stats/script.js/route';

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

// The analytics tracker stand-in (phase 8 S5): the e2e build asks for /stats/script.js on every
// marketing page. In every real build nginx serves that path (phase 11) and this route is a 404.
describe('stats/script.js', () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1'])(
    'answers 404 with no body when E2E_PROBES is %j',
    async (value) => {
      vi.stubEnv('E2E_PROBES', value);
      const response = statsScript();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    },
  );

  it('answers a script that sends nothing, never cached, when E2E_PROBES is 1', async () => {
    vi.stubEnv('E2E_PROBES', '1');
    const response = statsScript();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(/fetch|sendBeacon|XMLHttpRequest|api\/send/);
  });
});
