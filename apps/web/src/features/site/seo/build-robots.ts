import type { MetadataRoute } from 'next';

// What must not be crawled: the Mini App's inner pages (`/tg/...`; the `/tg` root itself does not
// match `/tg/` and says `noindex` instead), the payment page (a
// capability token sits in its URL), the developer gallery and the API. `/login` and `/store` are
// NOT listed on purpose: they carry `noindex`, and a crawler that is not allowed to fetch a page
// can never see that tag; the URL could then still be listed from a link elsewhere.
export const DISALLOWED_PATHS = ['/pay/', '/tg/', '/dev/', '/api/'] as const;

export function buildRobots(siteUrl: string): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: [...DISALLOWED_PATHS] },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
