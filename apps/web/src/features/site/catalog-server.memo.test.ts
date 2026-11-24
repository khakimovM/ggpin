import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutcomeMemo } from './catalog-memo';
import { getSiteProducts, lookupSiteProduct, resetSiteCatalogMemo } from './catalog-server';

// p8 S6 audit L-3: page views must not turn into API requests one to one when the API fails or a
// slug does not exist. Single-flight for parallel views, a short negative memory, a bounded size.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();
const answer = (make: () => Response) =>
  fetchMock.mockImplementation(() => Promise.resolve(make()));

beforeEach(() => {
  resetSiteCatalogMemo();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('catalog requests through the memo', () => {
  it('ten parallel views of the same product are one API request', async () => {
    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const views = Array.from({ length: 10 }, () => lookupSiteProduct('telegram-stars', 'uz'));
    release(json({ success: false }, 404));
    expect(await Promise.all(views)).toEqual(Array(10).fill({ status: 'not-found' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 is not asked again for 45 s, then it is', async () => {
    vi.useFakeTimers();
    answer(() => json({ success: false }, 404));
    await lookupSiteProduct('no-such-product', 'uz');
    vi.advanceTimersByTime(44_000);
    expect(await lookupSiteProduct('no-such-product', 'uz')).toEqual({ status: 'not-found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await lookupSiteProduct('no-such-product', 'uz');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the key holds the slug and the locale', async () => {
    answer(() => json({ success: false }, 404));
    await lookupSiteProduct('no-such-product', 'uz');
    await lookupSiteProduct('no-such-product', 'ru');
    await lookupSiteProduct('other-product', 'uz');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([503, 500, 429])('a %i is kept for 8 s only', async (status) => {
    vi.useFakeTimers();
    answer(() => json({}, status));
    expect(await getSiteProducts('uz')).toBeNull();
    vi.advanceTimersByTime(7_000);
    expect(await getSiteProducts('uz')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getSiteProducts('uz');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 4xx other than 404/429, a timeout and a success are not kept', async () => {
    answer(() => json({}, 400));
    await getSiteProducts('uz');
    await getSiteProducts('uz');
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await getSiteProducts('ru');
    await getSiteProducts('ru');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    answer(() => json({ success: true, data: [] }));
    await getSiteProducts('uz');
    await getSiteProducts('uz');
    // Success is the Next.js data cache's job (60 s), not this memo's.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OutcomeMemo', () => {
  it('keeps at most maxEntries outcomes, dropping the oldest', async () => {
    const memo = new OutcomeMemo<string>(2, () => 60_000);
    const load = vi.fn((value: string) => Promise.resolve(value));
    for (const key of ['a', 'b', 'c']) await memo.run(key, () => load(key));
    await memo.run('c', () => load('c'));
    await memo.run('b', () => load('b'));
    expect(load).toHaveBeenCalledTimes(3);
    await memo.run('a', () => load('a'));
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('a joined request whose leader rejected asks for itself', async () => {
    const memo = new OutcomeMemo<string>(10, () => 0);
    let fail: (error: Error) => void = () => {};
    const leader = memo.run('k', () => new Promise<string>((_, reject) => (fail = reject)));
    const joined = memo.run('k', () => Promise.resolve('own'));
    fail(new Error('control flow'));
    await expect(leader).rejects.toThrow('control flow');
    await expect(joined).resolves.toBe('own');
    // Nothing is left in flight: the next run loads again.
    await expect(memo.run('k', () => Promise.resolve('next'))).resolves.toBe('next');
  });
});
