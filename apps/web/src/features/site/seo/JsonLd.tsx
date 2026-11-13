import { serializeJsonLd, type JsonLdDocument } from './json-ld';

/**
 * Renders one JSON-LD document. Together with `ThemeScript` (a constant theme boot script) this is
 * one of the two places in the app that use `dangerouslySetInnerHTML`; what goes in here is the
 * output of `serializeJsonLd`, which cannot contain `</script>`. The block is data, not code, so
 * the CSP does not run or block it; the request's nonce is still put on it (`nonce` comes from
 * `requestNonce()`) to keep one rule for every <script> of a page: each carries the nonce of its
 * response.
 */
export function JsonLd({ data, nonce }: { data: JsonLdDocument; nonce?: string }) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
