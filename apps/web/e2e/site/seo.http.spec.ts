import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BRAND } from '@repo/shared';
import { SITE_PAGES } from '../../src/features/site/seo/site-pages';
import {
  E2E_BOT_URL,
  E2E_CATALOG_API_URL,
  E2E_CATALOG_ORIGIN,
  E2E_CHANNEL_URL,
} from '../support/app-env';

// Protocol-level SEO checks (phase 8 S0-A), run once in the `http` project: robots.txt, the
// sitemap and, for every URL in it, canonical, hreflang pairs, Open Graph and JSON-LD. The site
// URL of the e2e build is its own origin (playwright.config.ts), so every sitemap URL can be
// fetched as it is.

const SITE = 'http://localhost:3100';

type Attrs = Record<string, string>;

// The attributes (names lower-cased: React writes hrefLang) of every `<tag ...>` in the HTML (double-quoted values, as React writes them).
function tags(html: string, tag: string): Attrs[] {
  const found: Attrs[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))) {
    const attrs: Attrs = {};
    for (const pair of (match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[(pair[1] ?? '').toLowerCase()] = pair[2] ?? '';
    }
    found.push(attrs);
  }
  return found;
}

// hreflang -> href of the page's <link rel="alternate" hreflang> tags.
function hreflangs(html: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const link of tags(html, 'link')) {
    const lang = link['hreflang'];
    if (link['rel'] === 'alternate' && lang !== undefined) map[lang] = link['href'] ?? '';
  }
  return map;
}

const metaContent = (html: string, key: 'name' | 'property', value: string): string[] =>
  tags(html, 'meta')
    .filter((meta) => meta[key] === value)
    .map((meta) => meta['content'] ?? '');

async function sitemapLocs(request: APIRequestContext): Promise<string[]> {
  const xml = await (await request.get('/sitemap.xml')).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
}

const pathOf = (url: string) => {
  const { pathname } = new URL(url);
  return pathname;
};

test.describe('robots.txt', () => {
  test('allows the site, blocks /tg/ (Mini App inner pages; /tg itself is noindex), /pay/, /dev/ and /api/, names the sitemap', async ({
    request,
  }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');
    const body = await response.text();
    expect(body).toMatch(/^User-Agent: \*$/im);
    expect(body).toMatch(/^Allow: \/$/m);
    for (const path of ['/pay/', '/tg/', '/dev/', '/api/']) {
      expect(body).toContain(`Disallow: ${path}`);
    }
    expect(body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  test('does not hide /login or /store: they carry noindex and the crawler has to read it', async ({
    request,
  }) => {
    const body = await (await request.get('/robots.txt')).text();
    expect(body).not.toMatch(/Disallow: \/(login|store)/);
  });
});

test.describe('sitemap.xml', () => {
  test('is XML and lists every indexable page of the registry in both languages', async ({
    request,
  }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/xml/);
    const expected = SITE_PAGES.filter((page) => page.indexable).flatMap((page) => [
      `${SITE}${page.path === '/' ? '' : page.path}`,
      `${SITE}${page.path === '/' ? '/ru' : `/ru${page.path}`}`,
    ]);
    expect((await sitemapLocs(request)).sort()).toEqual(expected.sort());
  });

  test('never lists the store, the sign-in page, the Mini App or the payment page', async ({
    request,
  }) => {
    for (const loc of await sitemapLocs(request)) {
      expect(pathOf(loc)).not.toMatch(/^(?:\/ru)?\/(store|login|tg|pay|dev|api)(\/|$)/);
    }
  });

  test('every <loc> answers 200 and every alternate is a full URL of the same site', async ({
    request,
  }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    for (const loc of await sitemapLocs(request)) {
      expect((await request.get(loc)).status(), loc).toBe(200);
    }
    const alternates = tags(xml, 'xhtml:link');
    expect(alternates.length).toBeGreaterThan(0);
    for (const link of alternates) {
      expect(link['rel']).toBe('alternate');
      expect(['uz', 'ru', 'x-default']).toContain(link['hreflang']);
      expect(link['href']).toMatch(new RegExp(`^${SITE}(/|$)`));
    }
  });
});

test.describe('every sitemap URL: canonical, hreflang, language, Open Graph', () => {
  test('canonical is the page itself, hreflang pairs are complete and two-way', async ({
    request,
  }) => {
    for (const loc of await sitemapLocs(request)) {
      const html = await (await request.get(loc)).text();
      const canonical = tags(html, 'link').filter((link) => link['rel'] === 'canonical');
      expect(
        canonical.map((link) => link['href']),
        loc,
      ).toEqual([loc]);

      const alternates = hreflangs(html);
      expect(Object.keys(alternates).sort(), loc).toEqual(['ru', 'uz', 'x-default']);
      for (const href of Object.values(alternates)) expect(href).toMatch(/^http:\/\/localhost/);
      expect(Object.values(alternates), loc).toContain(loc);

      // Two-way: the other language version lists the very same set.
      for (const lang of ['uz', 'ru']) {
        const other = alternates[lang];
        const otherHtml = await (await request.get(other ?? '')).text();
        const back = hreflangs(otherHtml);
        expect(back, `${loc} -> ${other}`).toEqual(alternates);
      }
    }
  });

  test('<html lang> follows the URL', async ({ request }) => {
    for (const loc of await sitemapLocs(request)) {
      const html = await (await request.get(loc)).text();
      const lang = pathOf(loc) === '/ru' || pathOf(loc).startsWith('/ru/') ? 'ru' : 'uz';
      expect(html, loc).toContain(`<html lang="${lang}"`);
    }
  });

  test('Open Graph and Twitter tags describe the page in its own language', async ({ request }) => {
    for (const loc of await sitemapLocs(request)) {
      const html = await (await request.get(loc)).text();
      const ru = pathOf(loc) === '/ru' || pathOf(loc).startsWith('/ru/');
      expect(metaContent(html, 'property', 'og:url'), loc).toEqual([loc]);
      expect(metaContent(html, 'property', 'og:site_name'), loc).toEqual(['ggpin']);
      expect(metaContent(html, 'property', 'og:type'), loc).toEqual(['website']);
      expect(metaContent(html, 'property', 'og:locale'), loc).toEqual([ru ? 'ru_RU' : 'uz_UZ']);
      expect(metaContent(html, 'property', 'og:locale:alternate'), loc).toEqual([
        ru ? 'uz_UZ' : 'ru_RU',
      ]);
      expect(metaContent(html, 'property', 'og:title'), loc).toHaveLength(1);
      expect(metaContent(html, 'name', 'twitter:card'), loc).toEqual(['summary_large_image']);
    }
  });

  test('a ?utm_ copy of a page names the clean URL as its canonical', async ({ request }) => {
    const html = await (await request.get('/?utm_source=telegram&utm_campaign=launch')).text();
    const canonical = tags(html, 'link').filter((link) => link['rel'] === 'canonical');
    expect(canonical.map((link) => link['href'])).toEqual([SITE]);
  });
});

test.describe('home page head', () => {
  test('has the landing title and the application name', async ({ request }) => {
    const html = await (await request.get('/')).text();
    // The landing's own title; it names the brand itself, so the layout's template is not added.
    expect(html).toContain(`<title>${uz.site.meta.home.title.replace('{brand}', 'ggpin')}</title>`);
    expect(metaContent(html, 'name', 'application-name')).toEqual(['ggpin']);
    expect(metaContent(html, 'name', 'format-detection')).toEqual(['telephone=no']);
  });

  test('the title and the description are inside <head> (not streamed into the body)', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<title>');
    expect(head).toContain('name="description"');
    expect(head).toContain('rel="canonical"');
  });

  test('JSON-LD: parseable, carries the response nonce, names the bot and the channel', async ({
    request,
  }) => {
    const response = await request.get('/');
    const csp = response.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    const html = await response.text();
    const blocks = [
      ...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
    ];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const documents = blocks.map((block) => JSON.parse(block[1] ?? '') as Record<string, unknown>);
    for (const block of blocks) expect(block[0]).toContain(`nonce="${nonce}"`);

    const organization = documents.find((doc) => doc['@type'] === 'Organization');
    expect(organization).toMatchObject({ name: 'ggpin', url: SITE });
    expect(organization?.['sameAs']).toEqual([E2E_BOT_URL, E2E_CHANNEL_URL]);
    expect(documents.find((doc) => doc['@type'] === 'WebSite')).toMatchObject({ inLanguage: 'uz' });
    // No priced Product/Offer markup.
    expect(JSON.stringify(documents)).not.toMatch(/"(Product|Offer)"/);
  });

  test('the Russian home says so in its WebSite document', async ({ request }) => {
    const html = await (await request.get('/ru')).text();
    expect(html).toContain('"inLanguage":"ru"');
  });
});

test.describe('product pages head (phase 8 S3)', () => {
  for (const [lang, path, copy] of [
    ['uz', '/telegram-stars', uz.site.product.stars],
    ['ru', '/ru/telegram-stars', ru.site.product.stars],
    ['uz', '/telegram-premium', uz.site.product.premium],
    ['ru', '/ru/telegram-premium', ru.site.product.premium],
  ] as const) {
    test(`${path}: the title and the description are inside <head>, in the page's language`, async ({
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      const html = await response.text();
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head).toContain(`<title>${copy.meta.title} — ${BRAND.name}</title>`);
      expect(metaContent(head, 'name', 'description')).toEqual([copy.meta.description]);
      expect(head).toContain('rel="canonical"');
      expect(Object.keys(hreflangs(head)).sort()).toEqual(['ru', 'uz', 'x-default']);
      expect(html).toContain(`<html lang="${lang}"`);
    });
  }
});

test.describe('areas that must stay out of search keep saying so', () => {
  test('/login and /store carry noindex; /login keeps its own title', async ({ request }) => {
    for (const path of ['/login', '/ru/login', '/store']) {
      const html = await (await request.get(path)).text();
      expect(metaContent(html, 'name', 'robots'), path).toEqual(['noindex, nofollow']);
    }
    const login = await (await request.get('/login')).text();
    expect(login).toContain(`<title>${uz.web.login.title.replace('{brand}', 'ggpin')}</title>`);
  });
});

test.describe('fixture catalog (API_INTERNAL_URL of the e2e build)', () => {
  test('answers the public catalog with the real envelope and cache header', async ({
    request,
  }) => {
    expect(E2E_CATALOG_API_URL).toBe(`${E2E_CATALOG_ORIGIN}/api/v1`);
    const response = await request.get(
      `${E2E_CATALOG_API_URL}/catalog/products?locale=uz&limit=100`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('public, max-age=60');
    const body = (await response.json()) as { success: boolean; data: { slug: string }[] };
    expect(body.success).toBe(true);
    expect(body.data.map((product) => product.slug)).toEqual(
      expect.arrayContaining(['telegram-stars', 'telegram-premium']),
    );
    const missing = await request.get(`${E2E_CATALOG_API_URL}/catalog/products/nope?locale=uz`);
    expect(missing.status()).toBe(404);
  });
});
