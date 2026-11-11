// The served URL shape, in one place: app.setup.ts applies the prefix and the default version,
// and the per-path policies (CORS of the pay view) build their paths from the same constants,
// so a new prefix or version cannot leave a policy pointing at a path that no longer exists.
export const API_PREFIX = 'api';
export const API_DEFAULT_VERSION = '1';

/** The pay-view controller's route (D-39); its CORS policy matches the served path below. */
export const PAY_VIEW_ROUTE = 'payments/pay';

/** `/<prefix>/v<version>/<route>` as Fastify serves it. */
export function servedPath(route: string): string {
  return `/${API_PREFIX}/v${API_DEFAULT_VERSION}/${route}`;
}
