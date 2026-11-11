import { describe, expect, it } from 'vitest';
import { isGalleryEnabled } from './dev-gallery';

describe('isGalleryEnabled', () => {
  it('is on in development and in tests', () => {
    expect(isGalleryEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isGalleryEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isGalleryEnabled({})).toBe(true);
  });

  it('is off in production', () => {
    expect(isGalleryEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is on in a production build only for the e2e web server', () => {
    expect(isGalleryEnabled({ NODE_ENV: 'production', E2E_PROBES: '1' })).toBe(true);
  });

  it('any other probe value does not open it in production', () => {
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      expect(isGalleryEnabled({ NODE_ENV: 'production', E2E_PROBES: value })).toBe(false);
    }
  });
});
