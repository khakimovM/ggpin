import { DEFAULT_LOCALE, LOCALES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE_CLIENT, LOCALES_CLIENT } from './client-locales';

describe('client-locales', () => {
  it('says what @repo/shared says', () => {
    expect([...LOCALES_CLIENT]).toEqual([...LOCALES]);
    expect(DEFAULT_LOCALE_CLIENT).toBe(DEFAULT_LOCALE);
  });
});
