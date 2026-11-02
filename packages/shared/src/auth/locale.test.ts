import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, localeFromTelegram } from './locale';

describe('localeFromTelegram', () => {
  it.each(['ru', 'be', 'uk', 'kk', 'RU', 'ru-RU', 'uk_UA', 'Kk-kz'])('%s -> ru', (code) => {
    expect(localeFromTelegram(code)).toBe('ru');
  });

  it.each(['uz', 'en', 'pt-br', 'tr', 'ruu', 'r', '', '-ru', undefined])('%s -> uz', (code) => {
    expect(localeFromTelegram(code)).toBe('uz');
  });

  it('exposes the two locales with uz as the default', () => {
    expect(LOCALES).toEqual(['uz', 'ru']);
    expect(DEFAULT_LOCALE).toBe('uz');
  });
});
