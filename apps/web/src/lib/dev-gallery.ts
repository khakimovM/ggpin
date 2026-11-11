export interface GalleryEnv {
  NODE_ENV?: string;
  /** Set only by the Playwright web server; never in a real deployment. */
  E2E_PROBES?: string;
}

/**
 * The component gallery (/dev/ui) exists in development and in the e2e build, and nowhere else:
 * a production deployment answers 404 for it.
 */
export function isGalleryEnabled(env: GalleryEnv): boolean {
  return env.NODE_ENV !== 'production' || env.E2E_PROBES === '1';
}
