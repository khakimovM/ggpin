import {
  CATALOG_SEARCH_MAX_LENGTH,
  type CatalogCategory,
  type CatalogProductListItem,
} from '@repo/shared';

/**
 * The text the catalog is asked for: trimmed, control characters removed (the API refuses them:
 * a NUL byte would be a 500), at most 64 characters. Empty means "no filter".
 */
export function sanitizeSearch(raw: string): string {
  let text = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // C0 and C1 control characters; a plain space and the like stay.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    text += char;
  }
  return Array.from(text.trim()).slice(0, CATALOG_SEARCH_MAX_LENGTH).join('').trim();
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A category slug from a URL, or undefined (anything that is not a slug is no filter). */
export function parseCategory(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && value.length <= 64 && SLUG.test(value)
    ? value
    : undefined;
}

export interface CatalogSection {
  /** null: products of a category the category list does not (yet) know; shown without a title. */
  category: CatalogCategory | null;
  items: CatalogProductListItem[];
}

/**
 * Groups products under their categories, in the order the API sorted the categories. A product
 * whose category is not in the list (the two requests raced a catalog change) is not dropped: it
 * goes to a trailing section without a title.
 */
export function groupByCategory(
  categories: readonly CatalogCategory[],
  items: readonly CatalogProductListItem[],
): CatalogSection[] {
  const sections: CatalogSection[] = categories.map((category) => ({
    category,
    items: items.filter((item) => item.categorySlug === category.slug),
  }));
  const known = new Set(categories.map((category) => category.slug));
  const orphans = items.filter((item) => !known.has(item.categorySlug));
  if (orphans.length > 0) sections.push({ category: null, items: orphans });
  return sections.filter((section) => section.items.length > 0);
}
