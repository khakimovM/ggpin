import { expect, test, type Page } from '@playwright/test';
import { stubTelegramSdk } from './fixtures/telegram';
import { FAKE_UMAMI_TRACKER } from './support/fake-umami';
import { watchPage } from './support/gallery';

// Browser side of the nonce CSP (phase 7 X4): pages run without violations, injected code does
// not, and the pre-paint theme script still works because it carries the nonce.

interface Probe {
  violations: string[];
  theme: (string | undefined)[];
}

// Records CSP violations and every value data-theme takes, from the very first one. (Also keeps
// Telegram's SDK script, which /tg loads, off the network.)
async function installProbe(page: Page) {
  await stubTelegramSdk(page);
  await page.addInitScript(() => {
    const probe: Probe = { violations: [], theme: [] };
    (window as unknown as { __probe: Probe }).__probe = probe;
    document.addEventListener('securitypolicyviolation', (event) => {
      probe.violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
    // The init script runs before <html> exists, so the document itself is observed. Callbacks
    // are batched, so every value written in between is read from the records' oldValue.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue !== null) probe.theme.push(record.oldValue);
      }
      probe.theme.push(document.documentElement.dataset.theme);
    }).observe(document, {
      attributes: true,
      attributeFilter: ['data-theme'],
      attributeOldValue: true,
      subtree: true,
    });
  });
}

const probeOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);

const injectedFlag = (page: Page) =>
  page.evaluate(() => (window as unknown as { __injected?: string }).__injected);

const PAGES = ['/', '/ru', '/login', '/tg', '/nonexistent'];

test.describe('pages run under the nonce CSP', () => {
  for (const path of PAGES) {
    test(`${path}: hydrates with no violation and no console error`, async ({ page }) => {
      const problems = watchPage(page);
      await installProbe(page);
      await page.goto(path);
      // Hydration finished: the theme provider has written data-theme (the 404 page too: it is
      // rendered inside the locale layout).
      await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
      await page.waitForLoadState('networkidle');
      expect((await probeOf(page)).violations).toEqual([]);
      // A 404 page logs the failed document load itself; that is not a script problem.
      expect(problems.filter((line) => !line.includes('status of 404'))).toEqual([]);
    });
  }
});

// The threat is markup that reaches the page without the server's nonce (stored or reflected
// HTML injection): it is parser-inserted, and the policy must refuse it. The injection is
// simulated by rewriting the document response; its CSP header is kept as it is.
// (A script that is already running can still create <script> elements through the DOM:
// 'strict-dynamic' trusts those by design, so that case is not a CSP matter.)
async function injectIntoDocument(page: Page, markup: string) {
  await page.route(
    (url) => url.pathname === '/tg' || url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace('</body>', `${markup}</body>`);
      await route.fulfill({ response, body: html });
    },
  );
}

test.describe('injected markup is blocked', () => {
  test('an inline <script> without the nonce does not run and is reported', async ({ page }) => {
    await installProbe(page);
    await injectIntoDocument(page, "<script>window.__injected='ran'</script>");
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
    await expect
      .poll(async () => (await probeOf(page)).violations.join('|'))
      .toContain('script-src-elem');
    expect(await injectedFlag(page)).toBeUndefined();
  });

  test('same-origin script files are not trusted by origin alone', async ({ page }) => {
    await installProbe(page);
    await page.route('**/injected.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: "window.__injected = 'ran'" }),
    );
    await injectIntoDocument(page, '<script src="/injected.js"></script>');
    await page.goto('/tg');
    await expect
      .poll(async () => (await probeOf(page)).violations.join('|'))
      .toContain('injected.js');
    expect(await injectedFlag(page)).toBeUndefined();
  });

  test('a script from another origin is blocked', async ({ page }) => {
    await installProbe(page);
    await injectIntoDocument(page, '<script src="https://example.invalid/x.js"></script>');
    await page.goto('/');
    await expect
      .poll(async () => (await probeOf(page)).violations.join('|'))
      .toContain('example.invalid');
  });

  test('an inline event handler does not run', async ({ page }) => {
    await installProbe(page);
    await injectIntoDocument(
      page,
      "<img alt='' src='data:image/png;base64,broken' onerror=\"window.__injected='ran'\">",
    );
    await page.goto('/tg');
    await expect
      .poll(async () => (await probeOf(page)).violations.join('|'))
      .toContain('script-src-attr');
    expect(await injectedFlag(page)).toBeUndefined();
  });

  test('a javascript: link does not run', async ({ page }) => {
    await installProbe(page);
    await injectIntoDocument(page, "<a id='bad' href=\"javascript:window.__injected='ran'\">x</a>");
    await page.goto('/');
    await page.locator('#bad').click();
    await expect
      .poll(async () => (await probeOf(page)).violations.join('|'))
      .toContain('script-src-elem');
    expect(await injectedFlag(page)).toBeUndefined();
  });

  test('browsers hide the nonce value from the DOM, so it cannot be copied', async ({ page }) => {
    await page.goto('/');
    const readable = await page.evaluate(() => {
      const withNonce = document.querySelector('script[nonce]');
      return withNonce ? withNonce.getAttribute('nonce') : null;
    });
    expect(readable).toBe('');
  });
});

test.describe('theme script (first paint)', () => {
  test('stored dark: data-theme is dark from its first write', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('ggpin-theme', 'dark'));
    await installProbe(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const { theme, violations } = await probeOf(page);
    expect(theme.length).toBeGreaterThan(0);
    expect(new Set(theme)).toEqual(new Set(['dark']));
    expect(violations).toEqual([]);
  });

  test('stored light beats an OS dark setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => window.localStorage.setItem('ggpin-theme', 'light'));
    await installProbe(page);
    await page.goto('/ru');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(new Set((await probeOf(page)).theme)).toEqual(new Set(['light']));
  });

  test('nothing stored: the OS dark setting is used, with no light flash', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await installProbe(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(new Set((await probeOf(page)).theme)).toEqual(new Set(['dark']));
  });

  test('nothing stored and OS light: light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await installProbe(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(new Set((await probeOf(page)).theme)).toEqual(new Set(['light']));
  });

  test('the script is inline in the HTML head, ahead of the body', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('dataset.theme=');
  });
});

// Phase 8 S5: the Umami tag on the marketing pages. It is loaded from our own origin with the
// request's nonce, and the tracker posts to /stats/api/send, also our own origin: no new host.
test.describe('analytics under the nonce CSP', () => {
  test('the tracker loads and its beacon goes out without a violation', async ({ page }) => {
    await installProbe(page);
    await page.route('**/stats/script.js', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: FAKE_UMAMI_TRACKER }),
    );
    let beacons = 0;
    await page.route('**/stats/api/send', async (route) => {
      beacons += 1;
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
    await expect.poll(() => beacons).toBe(1);
    expect((await probeOf(page)).violations).toEqual([]);
  });
});
