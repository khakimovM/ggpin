import { readFileSync } from 'node:fs';
import { notFound } from 'next/navigation';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_REVALIDATE_SECONDS,
  getSiteProduct,
  getSiteProducts,
  lookupSiteProduct,
  resetSiteCatalogMemo,
} from './catalog-server';

const LIST_ITEM = {
  id: 'p1',
  slug: 'telegram-stars',
  categorySlug: 'telegram',
  name: 'Telegram Stars',
  imageUrl: '/assets/products/telegram-stars.svg',
  regionBadge: null,
  deliveryType: 'TG_USERNAME',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '550000',
};

const DETAIL = {
  id: 'p1',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
  description: null,
  help: null,
  imageUrl: '/assets/products/telegram-stars.svg',
  deliveryType: 'TG_USERNAME',
  regionBadge: null,
  isAuto: true,
  allowCustomQty: true,
  minQty: 50,
  maxQty: 100000,
  inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
  skus: [{ id: 's1', label: '50 ⭐', quantity: 50, tab: null, fromPriceTiyin: '1100000' }],
  unitPriceTiyin: '22000',
  stock: null,
  currency: 'UZS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown) => json({ success: true, data });
// A Response body can be read once: a mock that answers several calls builds a fresh one each time.
const answer = (make: () => Response) =>
  fetchMock.mockImplementation(() => Promise.resolve(make()));

const fetchMock = vi.fn<typeof fetch>();
let logged: string[];

beforeEach(() => {
  // Negative outcomes are kept in process memory (catalog-memo.ts): every test starts clean.
  resetSiteCatalogMemo();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const calledUrl = () => {
  const input = fetchMock.mock.calls[0]?.[0];
  return input instanceof URL ? input.href : typeof input === 'string' ? input : '';
};
const calledInit = () => fetchMock.mock.calls[0]?.[1] as RequestInit & { next?: unknown };

describe('getSiteProducts', () => {
  it('returns the validated list, asking for the locale and the 100-item page', async () => {
    fetchMock.mockResolvedValue(ok([LIST_ITEM]));
    const products = await getSiteProducts('ru');
    expect(products).toEqual([LIST_ITEM]);
    expect(calledUrl()).toBe('http://localhost:5000/api/v1/catalog/products?locale=ru&limit=100');
  });

  it('is cached for 60 s in the Next.js data cache and cut off after 3 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(ok([]));
    await getSiteProducts('uz');
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3000);
    expect(CATALOG_REVALIDATE_SECONDS).toBe(60);
    expect(calledInit().next).toEqual({ revalidate: 60 });
    expect(calledInit().signal).toBeInstanceOf(AbortSignal);
    expect(calledInit().signal?.aborted).toBe(false);
  });

  it('reads from API_INTERNAL_URL when it is set', async () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api:5000/api/v1');
    fetchMock.mockResolvedValue(ok([]));
    await getSiteProducts('uz');
    expect(calledUrl()).toBe('http://api:5000/api/v1/catalog/products?locale=uz&limit=100');
  });

  it('returns an empty list (not null) when the catalog is empty', async () => {
    fetchMock.mockResolvedValue(ok([]));
    expect(await getSiteProducts('uz')).toEqual([]);
  });

  it('passes the prices on exactly as strings or null, computing nothing', async () => {
    fetchMock.mockResolvedValue(ok([LIST_ITEM, { ...LIST_ITEM, slug: 'x', fromPriceTiyin: null }]));
    const products = await getSiteProducts('uz');
    expect(products?.map((p) => p.fromPriceTiyin)).toEqual(['550000', null]);
  });

  it('a payload that fails the shared schema is an outage: null, and the payload is not logged', async () => {
    fetchMock.mockResolvedValue(ok([{ ...LIST_ITEM, fromPriceTiyin: 5500.5, secret: 'leak-me' }]));
    expect(await getSiteProducts('uz')).toBeNull();
    expect(logged).toEqual(['[site-catalog] BAD_BODY']);
  });

  it('a body that is not JSON, or has no envelope, is null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 200 }));
    expect(await getSiteProducts('uz')).toBeNull();
    fetchMock.mockResolvedValueOnce(json([LIST_ITEM]));
    expect(await getSiteProducts('uz')).toBeNull();
  });

  it('a 5xx is null and only the status code is logged', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: { code: 'INTERNAL_ERROR' } }, 503));
    expect(await getSiteProducts('uz')).toBeNull();
    expect(logged).toEqual(['[site-catalog] HTTP_503']);
  });

  it('a network failure is null, not an exception', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED http://secret-host'));
    expect(await getSiteProducts('uz')).toBeNull();
    expect(logged).toEqual(['[site-catalog] NETWORK']);
  });

  it('a timeout is null and is told apart in the log', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await getSiteProducts('uz')).toBeNull();
    expect(logged).toEqual(['[site-catalog] TIMEOUT']);
  });

  it('lets a Next.js control-flow error (here notFound) out of the request, instead of calling it an outage', async () => {
    fetchMock.mockImplementation(() => {
      notFound();
    });
    await expect(getSiteProducts('uz')).rejects.toThrow();
    expect(logged).toEqual([]);
  });

  it('does the same when it happens while the body is read', async () => {
    let control: unknown;
    try {
      notFound();
    } catch (error) {
      control = error;
    }
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'json').mockRejectedValue(control);
    fetchMock.mockResolvedValue(response);
    await expect(getSiteProducts('uz')).rejects.toBe(control);
    expect(logged).toEqual([]);
  });

  it('a malformed API_INTERNAL_URL is null with a CONFIG code, and nothing is requested', async () => {
    vi.stubEnv('API_INTERNAL_URL', 'not a url');
    expect(await getSiteProducts('uz')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged).toEqual(['[site-catalog] CONFIG']);
  });
});

describe('lookupSiteProduct / getSiteProduct', () => {
  it('returns the product for a 200', async () => {
    answer(() => ok(DETAIL));
    const lookup = await lookupSiteProduct('telegram-stars', 'uz');
    expect(lookup).toEqual({ status: 'ok', product: DETAIL });
    expect(calledUrl()).toBe(
      'http://localhost:5000/api/v1/catalog/products/telegram-stars?locale=uz',
    );
    expect(await getSiteProduct('telegram-stars', 'uz')).toEqual(DETAIL);
  });

  it('tells a 404 (the product is gone) from an outage (we do not know)', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: false, error: { code: 'NOT_FOUND' } }, 404));
    expect(await lookupSiteProduct('telegram-stars', 'uz')).toEqual({ status: 'not-found' });
    resetSiteCatalogMemo();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect(await lookupSiteProduct('telegram-stars', 'uz')).toEqual({ status: 'unavailable' });
    resetSiteCatalogMemo();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await lookupSiteProduct('telegram-stars', 'uz')).toEqual({ status: 'unavailable' });
  });

  it('getSiteProduct is null for both a 404 and an outage', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    expect(await getSiteProduct('telegram-stars', 'uz')).toBeNull();
    resetSiteCatalogMemo();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect(await getSiteProduct('telegram-stars', 'uz')).toBeNull();
  });

  it('a detail that fails the schema (custom quantity without limits) is an outage', async () => {
    fetchMock.mockResolvedValue(ok({ ...DETAIL, minQty: null }));
    expect(await lookupSiteProduct('telegram-stars', 'uz')).toEqual({ status: 'unavailable' });
  });

  it.each(['../me/wallet', 'Telegram-Stars', 'a b', 'stars?x=1', '', 'a'.repeat(65)])(
    'a slug the API would refuse (%j) is "not found" without a request',
    async (slug) => {
      expect(await lookupSiteProduct(slug, 'uz')).toEqual({ status: 'not-found' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('what the module does not import', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'catalog-server.ts'), 'utf8');

  it('never loads the browser API client or its mock transport', () => {
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).not.toMatch(/lib\/api|mock/i);
  });

  it('does no money arithmetic', () => {
    expect(source).not.toMatch(/Number\(|parseFloat|parseInt|BigInt\(/);
  });
});
