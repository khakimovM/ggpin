import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BRAND } from '@repo/shared';

// Protocol-level checks of the information pages (phase 8 S4), run once in the `http` project, on
// the raw HTML as a crawler gets it: the legal drafts answer 200 with noindex and stay out of the
// sitemap; the FAQ and the contacts are indexable, with their title and description in <head>; the
// FAQ's structured data is in the HTML under the response's nonce. The sitemap-wide checks
// (canonical, hreflang, Open Graph of every listed URL) are in seo.http.spec.ts.

const SITE = 'http://localhost:3100';

type Attrs = Record<string, string>;

// The attributes of every `<tag ...>` in the HTML (React writes double-quoted values).
function tags(html: string, tag: string): Attrs[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((match) => {
    const attrs: Attrs = {};
    for (const pair of (match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[(pair[1] ?? '').toLowerCase()] = pair[2] ?? '';
    }
    return attrs;
  });
}

const metaNamed = (html: string, name: string) =>
  tags(html, 'meta')
    .filter((meta) => meta['name'] === name)
    .map((meta) => meta['content'] ?? '');

const linksWithRel = (html: string, rel: string) =>
  tags(html, 'link')
    .filter((link) => link['rel'] === rel)
    .map((link) => ({ href: link['href'] ?? '', hreflang: link['hreflang'] }));

async function headOf(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  const html = await response.text();
  return { response, html, head: html.slice(0, html.indexOf('</head>')) };
}

async function sitemapPaths(request: APIRequestContext): Promise<string[]> {
  const xml = await (await request.get('/sitemap.xml')).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1] ?? '').pathname);
}

const PAGES = [
  ['uz', '', uz],
  ['ru', '/ru', ru],
] as const;

test.describe('the legal drafts', () => {
  for (const [lang, prefix, copy] of PAGES) {
    for (const doc of ['terms', 'privacy'] as const) {
      const path = `${prefix}/${doc}`;
      test(`${path}: 200, noindex, its own title, canonical and the language pair`, async ({
        request,
      }) => {
        const { head, html } = await headOf(request, path);
        expect(metaNamed(head, 'robots')).toEqual(['noindex, follow']);
        expect(head).toContain(`<title>${copy.site.meta[doc].title} — ${BRAND.name}</title>`);
        // A draft says nothing about itself yet: no description, no structured data.
        expect(metaNamed(head, 'description')).toEqual([]);
        expect(html).not.toContain('application/ld+json');
        expect(linksWithRel(head, 'canonical').map((link) => link.href)).toEqual([
          `${SITE}${path}`,
        ]);
        const pair: Record<string, string> = {};
        for (const link of linksWithRel(head, 'alternate')) {
          if (link.hreflang !== undefined) pair[link.hreflang] = link.href;
        }
        expect(pair).toEqual({
          uz: `${SITE}/${doc}`,
          ru: `${SITE}/ru/${doc}`,
          'x-default': `${SITE}/${doc}`,
        });
        expect(html).toContain(`<html lang="${lang}"`);
      });
    }
  }

  test('are not in the sitemap; the FAQ and the contacts are, in both languages', async ({
    request,
  }) => {
    const paths = await sitemapPaths(request);
    for (const draft of ['/terms', '/ru/terms', '/privacy', '/ru/privacy']) {
      expect(paths).not.toContain(draft);
    }
    for (const page of ['/faq', '/ru/faq', '/contacts', '/ru/contacts']) {
      expect(paths).toContain(page);
    }
  });
});

test.describe('the FAQ and the contacts', () => {
  for (const [lang, prefix, copy] of PAGES) {
    for (const which of ['faq', 'contacts'] as const) {
      const path = `${prefix}/${which}`;
      test(`${path}: indexable, the title and the description inside <head>`, async ({
        request,
      }) => {
        const { head, html } = await headOf(request, path);
        const meta = copy.site.meta[which];
        expect(metaNamed(head, 'robots')).toEqual([]);
        expect(head).toContain(`<title>${meta.title} — ${BRAND.name}</title>`);
        expect(metaNamed(head, 'description')).toEqual([meta.description]);
        expect(html).toContain(`<html lang="${lang}"`);
      });
    }

    test(`${prefix}/faq: the trail and FAQPage are in the HTML, under the response's nonce`, async ({
      request,
    }) => {
      const { response, html } = await headOf(request, `${prefix}/faq`);
      const nonce = /'nonce-([^']+)'/.exec(
        response.headers()['content-security-policy'] ?? '',
      )?.[1];
      expect(nonce).toBeTruthy();
      const blocks = [
        ...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
      ];
      for (const block of blocks) expect(block[0]).toContain(`nonce="${nonce}"`);
      const documents = blocks.map(
        (block) => JSON.parse(block[1] ?? '') as { '@type': string; mainEntity?: unknown[] },
      );
      expect(documents.map((doc) => doc['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
      expect(documents[1]?.mainEntity).toHaveLength(8);
      // Every answer is in the HTML, open or closed: a crawler reads them all.
      expect(html).toContain(copy.site.faq.items.a5);
    });
  }
});
