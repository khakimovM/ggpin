import { describe, expect, it } from 'vitest';
import { buildRobots, DISALLOWED_PATHS } from './build-robots';

const SITE = 'https://ggpin.example';

describe('buildRobots', () => {
  const robots = buildRobots(SITE);

  it('allows the site, keeps crawlers out of the Mini App, payments, gallery and API', () => {
    expect(robots.rules).toEqual({
      userAgent: '*',
      allow: '/',
      disallow: ['/pay/', '/tg/', '/dev/', '/api/'],
    });
  });

  it('points at the sitemap with a full URL', () => {
    expect(robots.sitemap).toBe(`${SITE}/sitemap.xml`);
  });

  it('does not disallow /login or /store: they say noindex and the crawler must read it', () => {
    for (const path of DISALLOWED_PATHS) expect(path).not.toMatch(/login|store/);
  });
});
