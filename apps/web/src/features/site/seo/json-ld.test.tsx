import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonLd } from './JsonLd';
import { breadcrumbLd, faqLd, organizationLd, serializeJsonLd, websiteLd } from './json-ld';

describe('serializeJsonLd', () => {
  it('cannot be closed by a </script> in a value, and stays the same JSON', () => {
    const hostile = { name: '</script><script>alert(1)</script>', note: '<!-- x -->' };
    const text = serializeJsonLd(hostile);
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(JSON.parse(text)).toEqual(hostile);
  });

  it('escapes & and the two JavaScript line separators', () => {
    const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const value = { a: 'Tom & Jerry', b: ['x', ls, 'y', ps, 'z'].join('') };
    const text = serializeJsonLd(value);
    expect(text).not.toContain('&');
    expect(text).not.toContain(ls);
    expect(text).not.toContain(ps);
    const backslash = String.fromCharCode(92);
    for (const code of ['0026', '2028', '2029']) expect(text).toContain(backslash + 'u' + code);
    expect(JSON.parse(text)).toEqual(value);
  });

  it('keeps ordinary text (Uzbek apostrophes, Cyrillic) readable', () => {
    const value = { t: 'Telegramʼda o‘yin — Звёзды' };
    expect(serializeJsonLd(value)).toContain('Telegramʼda o‘yin — Звёзды');
  });

  it('drops undefined members', () => {
    expect(serializeJsonLd({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('JsonLd component', () => {
  it('renders one ld+json block with the nonce, and a hostile value cannot end it', () => {
    const html = renderToStaticMarkup(
      <JsonLd nonce="abc123" data={{ name: '</script><img src=x onerror=alert(1)>' }} />,
    );
    expect(html.startsWith('<script type="application/ld+json" nonce="abc123">')).toBe(true);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
  });

  it('renders without a nonce attribute when there is none', () => {
    expect(renderToStaticMarkup(<JsonLd data={{ a: 1 }} />)).toBe(
      '<script type="application/ld+json">{"a":1}</script>',
    );
  });
});

describe('documents', () => {
  it('Organization: name, url, sameAs; no logo until there is one', () => {
    const doc = organizationLd({
      name: 'ggpin',
      url: 'https://x.test/',
      sameAs: ['https://t.me/b'],
    });
    expect(doc).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'ggpin',
      url: 'https://x.test/',
      sameAs: ['https://t.me/b'],
    });
    expect(organizationLd({ name: 'g', url: 'u', sameAs: [], logo: 'l' })).toMatchObject({
      logo: 'l',
    });
    expect(organizationLd({ name: 'g', url: 'u', sameAs: [] })).not.toHaveProperty('sameAs');
  });

  it('WebSite carries the language', () => {
    expect(websiteLd({ name: 'ggpin', url: 'https://x.test/ru', inLanguage: 'ru' })).toMatchObject({
      '@type': 'WebSite',
      inLanguage: 'ru',
    });
  });

  it('BreadcrumbList numbers its items from 1', () => {
    const doc = breadcrumbLd([
      { name: 'Home', url: 'https://x.test/' },
      { name: 'Stars', url: 'https://x.test/telegram-stars' },
    ]);
    expect(doc['itemListElement']).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://x.test/' },
      { '@type': 'ListItem', position: 2, name: 'Stars', item: 'https://x.test/telegram-stars' },
    ]);
  });

  it('FAQPage maps questions and answers', () => {
    expect(faqLd([{ question: 'Q?', answer: 'A.' }])).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } },
      ],
    });
  });

  it('has no Product or Offer type (the catalog price is an estimate)', () => {
    const all = [
      organizationLd({ name: 'g', url: 'u', sameAs: [] }),
      websiteLd({ name: 'g', url: 'u', inLanguage: 'uz' }),
      breadcrumbLd([]),
      faqLd([]),
    ].map((doc) => JSON.stringify(doc));
    for (const text of all) expect(text).not.toMatch(/"Product"|"Offer"/);
  });
});
