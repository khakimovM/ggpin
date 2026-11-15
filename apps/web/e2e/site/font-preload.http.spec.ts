import { expect, test, type APIRequestContext } from '@playwright/test';

// The locale-aware headline font preload (phase 8 S6, src/app/font-preload.ts): uz preloads the
// Latin Unbounded file, ru the Cyrillic one plus the same Latin one (Russian headlines carry Latin
// brand names). React may announce a preload in the HTML, in the `Link` response header, or both,
// so both are read and the files are counted once.

const MEDIA = /^\/_next\/static\/media\/[\w.-]+\.woff2$/;

type Attrs = Record<string, string>;

function attrsOf(source: string): Attrs {
  const attrs: Attrs = {};
  for (const pair of source.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[(pair[1] ?? '').toLowerCase()] = pair[2] ?? '';
  }
  // Header parameters may be unquoted: rel=preload.
  for (const pair of source.matchAll(/;\s*([\w-]+)=([^";,\s]+)/g)) {
    attrs[(pair[1] ?? '').toLowerCase()] ??= pair[2] ?? '';
  }
  return attrs;
}

const isFontPreload = (attrs: Attrs) =>
  attrs['rel'] === 'preload' && attrs['as'] === 'font' && attrs['type'] === 'font/woff2';

async function fontPreloads(request: APIRequestContext, path: string): Promise<string[]> {
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  const hrefs = new Set<string>();
  for (const match of (await response.text()).matchAll(/<link\b([^>]*)>/g)) {
    const attrs = attrsOf(match[1] ?? '');
    if (isFontPreload(attrs)) hrefs.add(attrs['href'] ?? '');
  }
  // `Link: <url>; rel=preload; as="font"; ..., <url2>; ...` (the urls never hold a comma).
  for (const entry of (response.headers()['link'] ?? '').split(/,\s*(?=<)/)) {
    const href = /^<([^>]*)>/.exec(entry.trim())?.[1];
    if (href !== undefined && isFontPreload(attrsOf(entry))) hrefs.add(href);
  }
  return [...hrefs];
}

test.describe('headline font preload', () => {
  test('uz preloads one Latin file, ru the Cyrillic one and the same Latin one', async ({
    request,
  }) => {
    const uz = await fontPreloads(request, '/');
    const ru = await fontPreloads(request, '/ru');
    expect(uz).toHaveLength(1);
    expect(ru).toHaveLength(2);
    for (const href of [...uz, ...ru]) expect(href).toMatch(MEDIA);
    expect(ru).toContain(uz[0]);
  });

  test('every preloaded file answers 200 as font/woff2', async ({ request }) => {
    const hrefs = new Set([
      ...(await fontPreloads(request, '/')),
      ...(await fontPreloads(request, '/ru')),
    ]);
    expect(hrefs.size).toBe(2);
    for (const href of hrefs) {
      const file = await request.get(href);
      expect(file.status(), href).toBe(200);
      expect(file.headers()['content-type'], href).toBe('font/woff2');
    }
  });
});
