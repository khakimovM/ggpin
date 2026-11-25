// JSON-LD (schema.org) for the marketing pages: the types, the four documents the site uses, and
// the serializer that makes a document safe to put inside a <script> element.
//
// No `Product` / `Offer`: the catalog price is an estimate that follows the exchange rate, and a
// structured price would read as an offer (phase 8 plan, P8-Q17).

export type JsonLdValue =
  string | number | boolean | null | JsonLdValue[] | { [key: string]: JsonLdValue | undefined };

export type JsonLdDocument = { [key: string]: JsonLdValue | undefined };

const CONTEXT = 'https://schema.org';

// What could end a <script> element or an HTML comment inside a JSON string, plus the two line
// separators that were not allowed inside a JavaScript string before ES2019. JSON.stringify leaves
// all of them as they are, and a catalog name or description comes from the admin panel.
// (Built from char codes so that no editor or tool can turn the escapes back into the characters.)
const BACKSLASH = String.fromCharCode(92);
const UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

const escapeChar = (char: string): string =>
  `${BACKSLASH}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * The text for a `<script type="application/ld+json">`. Every `<`, `>` and `&` (and the two line
 * separators) becomes a backslash-u escape: still the same JSON for a parser, but `</script>` or
 * `<!--` can no longer appear in it.
 */
export function serializeJsonLd(document: JsonLdDocument): string {
  return JSON.stringify(document).replace(UNSAFE, escapeChar);
}

export function organizationLd(input: {
  name: string;
  url: string;
  /** Absolute URL of the logo; left out until the brand assets exist. */
  logo?: string;
  /** Profiles of the brand elsewhere: the bot, the channel. */
  sameAs: readonly string[];
}): JsonLdDocument {
  return {
    '@context': CONTEXT,
    '@type': 'Organization',
    name: input.name,
    url: input.url,
    ...(input.logo === undefined ? {} : { logo: input.logo }),
    ...(input.sameAs.length === 0 ? {} : { sameAs: [...input.sameAs] }),
  };
}

export function websiteLd(input: {
  name: string;
  url: string;
  /** IETF tag of the page's language (`uz`, `ru`). */
  inLanguage: string;
}): JsonLdDocument {
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    name: input.name,
    url: input.url,
    inLanguage: input.inLanguage,
  };
}

export function breadcrumbLd(items: readonly { name: string; url: string }[]): JsonLdDocument {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function faqLd(items: readonly { question: string; answer: string }[]): JsonLdDocument {
  return {
    '@context': CONTEXT,
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
