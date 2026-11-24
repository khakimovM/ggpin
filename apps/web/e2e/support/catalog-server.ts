// A stand-in for the public catalog of the API (docs/04 "Katalog"), for the website's server-side
// rendering in e2e runs and in the Lighthouse run: `API_INTERNAL_URL` points here. It needs no
// database, no Redis and no real API, so site specs never wait for the one real stack.
//
//   node e2e/support/catalog-server.ts          (Node 24 runs the TypeScript directly)
//
// Answers like the real API: the `{ success, data, meta }` envelope, `Cache-Control: public,
// max-age=60` on a 200, a strict query (an unknown key is a 400), a 404 for an unknown product.
// `POST /__fixture/mode {"mode":"ok|error|slow|drop|sparse"}` breaks it on purpose (degradation specs),
// `GET /__fixture/stats` counts the catalog requests it has served (cache specs).
// `FIXTURE_MODE=error` starts it already broken: the site keeps a catalog answer in its data cache
// for 60 s, so a spec cannot switch ONE server from ok to error and expect the page to follow. A
// scenario that needs a broken API gets its own fixture (own port, own cache key) and, with it, its
// own site server (see playwright.config.ts).
// `sparse` is a catalog that is up but thin: the list is whole, the Stars detail has no packages and
// the Premium detail is a 404 (the product pages' "no packages" and "not for sale" states).
import { ProductListQuerySchema, SlugSchema } from '@repo/shared';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  assertFixturesMatchContract,
  categories,
  productDetail,
  productList,
  type FixtureLocale,
} from './catalog-server-data.ts';

const PORT = Number(process.env.FIXTURE_CATALOG_PORT ?? 5100);
const PREFIX = '/api/v1/catalog';
// Longer than the site's 3 s limit for the API, so `slow` proves the timeout.
const SLOW_MS = 6_000;

const MODES = ['ok', 'error', 'slow', 'drop', 'sparse'] as const;
type Mode = (typeof MODES)[number];
const isMode = (value: unknown): value is Mode => MODES.some((mode) => mode === value);

const initialMode: unknown = process.env.FIXTURE_MODE;
let mode: Mode = isMode(initialMode) ? initialMode : 'ok';
const stats = { catalog: 0, products: 0, details: 0 };

assertFixturesMatchContract();

function send(res: ServerResponse, status: number, body: unknown, cacheable = false): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': cacheable ? 'public, max-age=60' : 'no-store',
  });
  res.end(JSON.stringify(body));
}

const failure = (code: string) => ({ success: false, error: { code, message: `errors.${code}` } });
const localeOf = (value: string | null): FixtureLocale | null =>
  value === null || value === 'uz' ? 'uz' : value === 'ru' ? 'ru' : null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += String(chunk)));
    req.on('end', () => resolve(text));
  });
}

async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === '/__fixture/stats') return send(res, 200, stats);
  if (path === '/__fixture/mode' && req.method === 'POST') {
    const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
    const next: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'mode') : null;
    if (!isMode(next)) return send(res, 400, failure('BAD_MODE'));
    mode = next;
    return send(res, 200, { mode });
  }
  if (path === '/__fixture/reset' && req.method === 'POST') {
    mode = 'ok';
    stats.catalog = stats.products = stats.details = 0;
    return send(res, 200, { mode });
  }
  return send(res, 404, failure('NOT_FOUND'));
}

async function catalog(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  stats.catalog += 1;
  if (mode === 'drop') return void req.socket.destroy();
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  if (mode === 'error') return send(res, 500, failure('INTERNAL_ERROR'));

  const route = url.pathname.slice(PREFIX.length);
  const locale = localeOf(url.searchParams.get('locale'));
  if (locale === null) return send(res, 400, failure('VALIDATION_ERROR'));

  if (route === '/categories') {
    return send(res, 200, { success: true, data: categories(locale) }, true);
  }

  if (route === '/products') {
    const query = ProductListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return send(res, 400, failure('VALIDATION_ERROR'));
    stats.products += 1;
    const { category, q, page, limit } = query.data;
    const matching = productList().filter(
      (product) =>
        (category === undefined || product.categorySlug === category) &&
        (q === undefined || product.name.toLowerCase().includes(q.toLowerCase())),
    );
    const items = matching.slice((page - 1) * limit, page * limit);
    const meta = { page, limit, total: matching.length };
    return send(res, 200, { success: true, data: items, meta }, true);
  }

  const slug = /^\/products\/([^/]+)$/.exec(route)?.[1];
  if (slug !== undefined) {
    stats.details += 1;
    const found = SlugSchema.safeParse(slug).success ? productDetail(slug, locale) : null;
    const gone = mode === 'sparse' && slug === 'telegram-premium';
    if (found === null || gone) return send(res, 404, failure('NOT_FOUND'));
    const detail = mode === 'sparse' && slug === 'telegram-stars' ? { ...found, skus: [] } : found;
    return send(res, 200, { success: true, data: detail }, true);
  }
  return send(res, 404, failure('NOT_FOUND'));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const run = async () => {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/__fixture/')) return control(req, res, url.pathname);
    if (req.method === 'GET' && url.pathname.startsWith(`${PREFIX}/`)) {
      return catalog(req, res, url);
    }
    return send(res, 404, failure('NOT_FOUND'));
  };
  run().catch(() => {
    if (!res.headersSent) send(res, 500, failure('INTERNAL_ERROR'));
  });
});

// `localhost` (not all interfaces): a test fixture has no business listening on the network.
server.listen(PORT, 'localhost', () => {
  console.log(`fixture catalog listening on http://localhost:${PORT}`);
});
