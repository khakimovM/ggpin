import type { MetadataRoute } from 'next';
import { env } from '../env';
import { buildSitemap } from '../features/site/seo/build-sitemap';

export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap(env.NEXT_PUBLIC_SITE_URL);
}
