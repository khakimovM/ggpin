/**
 * Whether the seeded demo products are created active (visible and buyable in the catalog).
 * Fails closed: only an explicit `development` or `test` activates them. Production, an unset
 * NODE_ENV or any other value (a typo such as "prod", "staging") leaves them inactive, so a seed
 * run on a real database can never publish demo products by accident.
 */
export function shouldActivateProducts(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/** The seed log suffix; says why products are inactive and how to get active demo products. */
export function inactiveProductsNote(activated: boolean): string {
  return activated
    ? ''
    : ' (products inactive: NODE_ENV is not "development" or "test"; run with NODE_ENV=development for active demo products)';
}
