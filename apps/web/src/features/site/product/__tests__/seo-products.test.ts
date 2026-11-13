import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { SITE_PAGES } from '../../seo/site-pages';
import { SEO_PRODUCTS, seoProduct, type FactKind, type SeoProductSlug } from '../seo-products';

// The texts a card or a package note reads from the product's own block, because they are counted
// in the product's unit (⭐ for Stars): a product whose registry entry lists the card needs them.
const UNIT_TEXTS: Partial<Record<FactKind, readonly string[]>> = {
  unitPrice: ['facts.unitPrice.value'],
  min: ['facts.min.value', 'packages.customQty', 'packages.noPackagesMin'],
};

/** The string at a dotted path of a catalog block, or undefined. */
function textAt(root: unknown, path: string): string | undefined {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' ? node : undefined;
}

describe('the SEO product registry', () => {
  it('has a page in the site registry for each product, indexable, and no other product page', () => {
    for (const product of SEO_PRODUCTS) {
      const page = SITE_PAGES.find((candidate) => candidate.path === product.path);
      expect(page, product.slug).toBeDefined();
      expect(page?.indexable, product.slug).toBe(true);
    }
    // Every page of the site registry but the home is a product page, or one of a later slice.
    const productPaths = new Set<string>(SEO_PRODUCTS.map((product) => product.path));
    for (const page of SITE_PAGES) {
      if (page.path === '/') continue;
      expect(productPaths.has(page.path), page.path).toBe(true);
    }
  });

  it('a path is the slug (the folder under (marketing) and the catalog slug are one name)', () => {
    for (const product of SEO_PRODUCTS) expect(product.path).toBe(`/${product.slug}`);
  });

  it('has the texts of every product in both languages: meta, lead, packages, steps, questions', () => {
    for (const locale of ['uz', 'ru'] as const) {
      for (const product of SEO_PRODUCTS) {
        const copy = MESSAGES[locale].site.product[product.contentKey];
        expect(copy.meta.title.trim(), `${locale}:${product.slug}`).not.toBe('');
        expect(copy.meta.description.length).toBeLessThanOrEqual(170);
        expect(copy.lead).not.toBe('');
        expect(copy.packages.label).not.toBe('');
        for (const step of ['s1', 's2', 's3'] as const) {
          expect(copy.how[step].title).not.toBe('');
          expect(copy.how[step].text).not.toBe('');
        }
        const items: Record<string, string> = copy.faq.items;
        for (let n = 1; n <= product.faqCount; n += 1) {
          expect(items[`q${n}`], `${locale}:${product.slug}:q${n}`).toBeTruthy();
          expect(items[`a${n}`], `${locale}:${product.slug}:a${n}`).toBeTruthy();
        }
        expect(Object.keys(items)).toHaveLength(product.faqCount * 2);
      }
    }
  });

  it('writes no price, no brand handle and no hardcoded amount into the product copy', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const text = JSON.stringify(MESSAGES[locale].site.product);
      // A price in a promise would go stale and would be an offer (P8-Q17, P8-Q19).
      expect(text).not.toMatch(/\d[\d\s]*(so‘m|сум|UZS)/);
      expect(text).not.toMatch(/ggpin|@\w/i);
    }
  });

  it("texts in a product's own unit live in its own block, never in the shared one", () => {
    for (const locale of ['uz', 'ru'] as const) {
      const copy = MESSAGES[locale].site.product;
      // ⭐ is the unit of Stars: what every product page shares says nothing about it.
      expect(JSON.stringify(copy.common)).not.toContain('⭐');
      for (const product of SEO_PRODUCTS) {
        for (const kind of product.facts) {
          for (const path of UNIT_TEXTS[kind] ?? []) {
            const where = `${locale}:${product.slug}:${path}`;
            expect(textAt(copy[product.contentKey], path), where).toBeTruthy();
          }
        }
      }
    }
  });

  it('a note never ends a line inside "from 50 ⭐" (no-break spaces)', () => {
    // The minimum, its unit and the word that goes with them stay on one line: in Uzbek "dan"
    // after the star (alone at the start of a line it reads as a typo), in Russian "от" before the
    // number.
    const bound = {
      uz: '{min, number}\u00A0⭐\u00A0dan',
      ru: 'от\u00A0{min, number}\u00A0⭐',
    };
    for (const locale of ['uz', 'ru'] as const) {
      const { packages } = MESSAGES[locale].site.product.stars;
      for (const text of [packages.customQty, packages.noPackagesMin]) {
        expect(text, locale).toContain(bound[locale]);
      }
    }
  });

  it('the payment text names Humo and Uzcard only', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const text = JSON.stringify(MESSAGES[locale].site.product);
      expect(text).not.toMatch(/Click|Payme|Uzum|Rahmat/i);
    }
  });

  it('looks a product up by slug, and fails loudly for an unknown one', () => {
    expect(seoProduct('telegram-stars').glyph).toBe('star');
    expect(seoProduct('telegram-premium').glyph).toBe('crown');
    expect(() => seoProduct('no-such-product' as SeoProductSlug)).toThrow('no SEO product');
  });
});
