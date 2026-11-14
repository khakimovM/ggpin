import { describe, expect, it } from 'vitest';
import { SITE_PAGES } from '../../seo/site-pages';
import { analyticsBeforeSend } from '../analytics-before-send';
import { isTrackedPath } from '../tracked-paths';

const ORIGIN = 'https://ggpin.example';

// A page view as the Umami tracker builds it (src/tracker/index.ts, getPayload).
const pageView = (url: string, referrer = '') => ({
  website: '94db1cb1-74f4-4a40-ad6c-962362670409',
  screen: '390x844',
  language: 'uz',
  title: 'ggpin',
  hostname: 'ggpin.example',
  url,
  referrer,
  tag: undefined,
  id: undefined,
  salt: undefined,
});

const send = (payload: unknown, type: unknown = 'event') =>
  analyticsBeforeSend(type, payload, ORIGIN);

describe('isTrackedPath', () => {
  it('tracks every page of the site registry, in uz (no prefix) and ru', () => {
    for (const { path } of SITE_PAGES) {
      expect(isTrackedPath(path)).toBe(true);
      expect(isTrackedPath(path === '/' ? '/ru' : `/ru${path}`)).toBe(true);
    }
  });

  it.each([
    '/store',
    '/store/telegram-stars',
    '/ru/store',
    '/login',
    '/ru/login',
    '/store/account',
    '/store/orders/ord_1',
    '/tg',
    '/tg/wallet',
    '/pay/top_1',
    '/uz',
    '/uz/faq',
    '/faq/',
    '/e2e-probe-error',
    '/nonexistent',
    '',
  ])('never tracks %j', (path) => {
    expect(isTrackedPath(path)).toBe(false);
  });
});

describe('analyticsBeforeSend', () => {
  it('passes a page view of a marketing page with the allowlisted fields only', () => {
    expect(send(pageView(`${ORIGIN}/ru/faq`))).toStrictEqual({
      website: '94db1cb1-74f4-4a40-ad6c-962362670409',
      screen: '390x844',
      language: 'uz',
      title: 'ggpin',
      hostname: 'ggpin.example',
      url: `${ORIGIN}/ru/faq`,
      referrer: '',
    });
  });

  it('drops every field outside the allowlist, and allowlisted fields that are not strings', () => {
    const out = send({
      ...pageView(`${ORIGIN}/`),
      tag: 'campaign',
      salt: 'abc',
      phone: '998901234567',
      session: { id: 1 },
      title: { toString: () => 'x' },
      screen: 390,
    });
    expect(out).not.toBe(false);
    expect(Object.keys(out || {}).sort()).toEqual(
      ['hostname', 'language', 'referrer', 'url', 'website'].sort(),
    );
  });

  it('strips the query and the hash from the URL, whatever the tracker left in', () => {
    const out = send(pageView(`${ORIGIN}/telegram-stars?utm_source=x&t=abc#t=secret`));
    expect(out).not.toBe(false);
    expect(out && out.url).toBe(`${ORIGIN}/telegram-stars`);
  });

  it.each([
    [`${ORIGIN}/store`, 'the store'],
    [`${ORIGIN}/ru/login?next=%2Fstore`, 'the login'],
    [`${ORIGIN}/store/account#x`, 'an account page'],
    [`${ORIGIN}/pay/top_1#t=secret`, 'the payment page'],
    [`${ORIGIN}/tg`, 'the Mini App'],
    ['https://other.example/', 'another origin'],
    ['not a url at all', 'a value that is not a URL'],
  ])('drops a page view of %s (%s)', (url) => {
    expect(send(pageView(url))).toBe(false);
  });

  it.each([
    ['https://search.example/q?text=ggpin#frag', 'https://search.example'],
    ['https://search.example/', 'https://search.example'],
    ['http://blog.example:8080/posts/ggpin-review?utm=1', 'http://blog.example:8080'],
    ['//cdn.example/path/to/page', 'https://cdn.example'],
  ])('keeps only the origin of an outside referrer: %j -> %j', (raw, expected) => {
    const out = send(pageView(`${ORIGIN}/`, raw));
    expect(out && out.referrer).toBe(expected);
  });

  it.each([
    ['/ru/contacts?x=1#t=secret', '/ru/contacts'],
    ['/', '/'],
    ['/faq', '/faq'],
    [`${ORIGIN}/telegram-stars?utm_source=x`, '/telegram-stars'],
    [`${ORIGIN}/ru#products`, '/ru'],
  ])('keeps a referrer of our own marketing page as a path: %j -> %j', (raw, expected) => {
    const out = send(pageView(`${ORIGIN}/faq`, raw));
    expect(out && out.referrer).toBe(expected);
  });

  it.each([
    '/store/orders/x',
    `${ORIGIN}/store/orders/cm3order0000000000000001`,
    '/store',
    '/store/profile',
    '/login',
    '/ru/login',
    `${ORIGIN}/ru/login?next=%2Fstore`,
    '/pay/top_1',
    `${ORIGIN}/pay/top_1#t=secret`,
    '/tg',
    '/tg/wallet',
    '/faq/',
    '/nonexistent',
  ])('sends an empty referrer for our own page outside the marketing pages: %j', (raw) => {
    const out = send(pageView(`${ORIGIN}/faq`, raw));
    expect(out).not.toBe(false);
    expect(out && out.referrer).toBe('');
  });

  it('sends an empty referrer for none, one that is not a URL, and one without an origin', () => {
    expect(send(pageView(`${ORIGIN}/`))).toMatchObject({ referrer: '' });
    expect(send(pageView(`${ORIGIN}/`, 'http://[bad'))).toMatchObject({ referrer: '' });
    expect(send(pageView(`${ORIGIN}/`, 'data:text/html,hi'))).toMatchObject({ referrer: '' });
    expect(send(pageView(`${ORIGIN}/`, 'android-app://com.example.app/'))).toMatchObject({
      referrer: '',
    });
    expect(send({ ...pageView(`${ORIGIN}/`), referrer: 42 })).toMatchObject({ referrer: '' });
  });

  it('never sends a user id or custom data', () => {
    const out = send({ ...pageView(`${ORIGIN}/`), id: 'user-42', data: { phone: '998' } });
    expect(out).not.toBe(false);
    expect(out && 'id' in out).toBe(false);
    expect(out && 'data' in out).toBe(false);
  });

  it.each(['performance', 'error', 'identify', undefined])('drops a %s payload', (type) => {
    expect(analyticsBeforeSend(type, pageView(`${ORIGIN}/`), ORIGIN)).toBe(false);
  });

  it('drops custom events (named) and payloads that are not objects', () => {
    expect(send({ ...pageView(`${ORIGIN}/`), name: 'click' })).toBe(false);
    expect(send(null)).toBe(false);
    expect(send('x')).toBe(false);
    expect(send([pageView(`${ORIGIN}/`)])).toBe(false);
    expect(send({ ...pageView(`${ORIGIN}/`), url: 42 })).toBe(false);
  });
});
