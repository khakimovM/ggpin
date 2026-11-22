/** `ORDERS_NEEDS_REVIEW` → `ordersNeedsReview`, at the type level too (typed i18n keys). */
export type CamelKey<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Lowercase<Head>}${Capitalize<CamelKey<Tail>>}`
  : Lowercase<S>;

/**
 * Catalog keys are camelCase segments (`area.screen.element`), API enums are UPPER_SNAKE: this is
 * the one bridge between them, so a screen never builds a key from a raw enum value.
 */
export function camelKey<S extends string>(value: S): CamelKey<S> {
  const [head = '', ...rest] = value.toLowerCase().split('_');
  const tail = rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return `${head}${tail}` as CamelKey<S>;
}
