import { describe, expect, it } from 'vitest';
import { canonicalPath, pageMetadata, pageUrl, TITLE_TEMPLATE } from './page-metadata';

const SITE = 'https://ggpin.example';

describe('canonicalPath', () => {
  it.each([
    ['/faq', '/faq'],
    ['/faq/', '/faq'],
    ['/faq?utm_source=x&utm_medium=y', '/faq'],
    ['/faq#how', '/faq'],
    ['/faq/?a=1#b', '/faq'],
    ['/', '/'],
    ['/?utm_source=x', '/'],
    ['', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });
});

describe('pageUrl', () => {
  it('has no prefix for uz and /ru for ru', () => {
    expect(pageUrl(SITE, 'uz', '/telegram-stars')).toBe(`${SITE}/telegram-stars`);
    expect(pageUrl(SITE, 'ru', '/telegram-stars')).toBe(`${SITE}/ru/telegram-stars`);
    expect(pageUrl(SITE, 'uz', '/')).toBe(SITE);
    expect(pageUrl(SITE, 'ru', '/')).toBe(`${SITE}/ru`);
  });
});

describe('pageMetadata', () => {
  const meta = (locale: 'uz' | 'ru', path: `/${string}` = '/faq') =>
    pageMetadata({ locale, path, title: 'FAQ', description: 'Answers' }, SITE);

  it('points the canonical at the page itself, with a full URL, per locale', () => {
    expect(meta('uz').alternates?.canonical).toBe(`${SITE}/faq`);
    expect(meta('ru').alternates?.canonical).toBe(`${SITE}/ru/faq`);
    expect(meta('ru', '/').alternates?.canonical).toBe(`${SITE}/ru`);
  });

  it('lists uz, ru and x-default as full URLs, the same on both language versions', () => {
    const expected = { uz: `${SITE}/faq`, ru: `${SITE}/ru/faq`, 'x-default': `${SITE}/faq` };
    expect(meta('uz').alternates?.languages).toEqual(expected);
    expect(meta('ru').alternates?.languages).toEqual(expected);
  });

  it('never lets a query string or fragment into the canonical or the alternates', () => {
    const dirty = pageMetadata(
      { locale: 'uz', path: '/faq?utm_source=tg&utm_campaign=x#top', title: 'FAQ' },
      SITE,
    );
    const urls = [
      dirty.alternates?.canonical,
      ...Object.values(dirty.alternates?.languages ?? {}),
      dirty.openGraph?.url,
    ];
    const strings = urls.filter((url): url is string => typeof url === 'string');
    expect(strings).toHaveLength(5);
    for (const url of strings) expect(url).not.toMatch(/[?#]/);
    expect(dirty.alternates?.canonical).toBe(`${SITE}/faq`);
  });

  it('describes the page for Open Graph in its own locale and names the other', () => {
    expect(meta('uz').openGraph).toMatchObject({
      type: 'website',
      siteName: 'ggpin',
      url: `${SITE}/faq`,
      locale: 'uz_UZ',
      alternateLocale: ['ru_RU'],
      title: 'FAQ — ggpin',
      description: 'Answers',
    });
    expect(meta('ru').openGraph).toMatchObject({ locale: 'ru_RU', alternateLocale: ['uz_UZ'] });
  });

  it('uses the large-image Twitter card', () => {
    expect(meta('uz').twitter).toMatchObject({ card: 'summary_large_image', title: 'FAQ — ggpin' });
  });

  it('adds the share image as a full URL only when there is one', () => {
    expect(meta('uz').openGraph).not.toHaveProperty('images');
    const withImage = pageMetadata(
      { locale: 'uz', path: '/faq', title: 'FAQ', ogImage: '/og/faq.png' },
      SITE,
    );
    expect(withImage.openGraph?.images).toEqual([{ url: `${SITE}/og/faq.png` }]);
    expect(withImage.twitter?.images).toEqual([`${SITE}/og/faq.png`]);
  });

  it('leaves description out when there is none (no empty tag)', () => {
    const bare = pageMetadata({ locale: 'uz', path: '/', title: 'ggpin' }, SITE);
    expect(bare).not.toHaveProperty('description');
    expect(bare.openGraph).not.toHaveProperty('description');
  });

  it('title goes through the layout template, or is absolute when it names the brand', () => {
    expect(TITLE_TEMPLATE).toBe('%s — ggpin');
    expect(meta('uz').title).toBe('FAQ');
    const absolute = pageMetadata(
      { locale: 'uz', path: '/', title: 'ggpin — Stars', titleAbsolute: true },
      SITE,
    );
    expect(absolute.title).toEqual({ absolute: 'ggpin — Stars' });
    expect(absolute.openGraph?.title).toBe('ggpin — Stars');
  });

  it('a draft page asks not to be indexed; an ordinary page says nothing', () => {
    const draft = pageMetadata({ locale: 'uz', path: '/terms', title: 'T', noindex: true }, SITE);
    expect(draft.robots).toEqual({ index: false, follow: true });
    expect(meta('uz')).not.toHaveProperty('robots');
  });
});
