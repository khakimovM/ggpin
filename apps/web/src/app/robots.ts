import type { MetadataRoute } from 'next';
import { env } from '../env';
import { buildRobots } from '../features/site/seo/build-robots';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(env.NEXT_PUBLIC_SITE_URL);
}
