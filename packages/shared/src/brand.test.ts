import { describe, expect, it } from 'vitest';
import { BRAND } from './index';

describe('BRAND', () => {
  it('keeps the wordmark lowercase (D-13)', () => {
    expect(BRAND.name).toBe(BRAND.name.toLowerCase());
  });

  it('serves the site from a bare domain without protocol or path', () => {
    expect(BRAND.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
});
