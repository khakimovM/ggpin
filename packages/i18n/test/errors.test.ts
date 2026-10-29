import { ERROR_CODES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import ru from '../ru.json';
import uz from '../uz.json';

// The wire `message` is `errors.<CODE>` (docs/04); a code without text would show a raw key.
describe('error code translations', () => {
  it.each([
    ['uz', uz],
    ['ru', ru],
  ] as const)(
    '%s has a non-empty message for every ErrorCode and no extras',
    (_locale, catalog) => {
      expect(Object.keys(catalog.errors).sort()).toEqual([...ERROR_CODES].sort());
      for (const code of ERROR_CODES) {
        expect(catalog.errors[code].trim(), code).not.toBe('');
      }
    },
  );

  it('has a money unit key per currency in both locales', () => {
    for (const catalog of [uz, ru]) {
      expect(Object.keys(catalog.common.money).sort()).toEqual(['stars', 'ton', 'usdt', 'uzs']);
      for (const text of Object.values(catalog.common.money)) expect(text).toContain('{amount}');
    }
  });
});
