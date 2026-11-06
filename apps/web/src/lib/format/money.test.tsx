import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { render, renderHook, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Money, useFormatMoney } from './money';
import { formatTiyinString } from './tiyin';

const CATALOGS = { uz, ru } as const;

function withLocale(locale: 'uz' | 'ru') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={CATALOGS[locale]}>
        {children}
      </NextIntlClientProvider>
    );
  };
}

// NBSP and narrow NBSP are layout; compare with plain spaces.
const plain = (text: string | null): string => (text ?? '').replace(/[\s\p{Z}]+/gu, ' ').trim();

describe('<Money>', () => {
  it.each([
    ['uz', '1255000', '12 550 so‘m'],
    ['ru', '1255000', '12 550 сум'],
    ['uz', '0', '0 so‘m'],
    ['ru', '8540050', '85 400,50 сум'],
  ] as const)('%s: %s tiyin -> %s', (locale, tiyin, expected) => {
    render(<Money tiyin={tiyin} />, { wrapper: withLocale(locale) });
    expect(plain(screen.getByText(/\d/).closest('span')?.textContent ?? null)).toBe(expected);
  });

  it('shows a negative amount with a real minus sign', () => {
    const { container } = render(<Money tiyin="-120000" />, { wrapper: withLocale('uz') });
    expect(plain(container.textContent)).toBe('−1 200 so‘m');
  });

  it('does not lose precision on a BIGINT-sized string (no Number in the path)', () => {
    const { container } = render(<Money tiyin="9223372036854775807" />, {
      wrapper: withLocale('ru'),
    });
    expect(plain(container.textContent)).toBe('92 233 720 368 547 758,07 сум');
  });

  it.each(['', '12.5', '1e6', 'abc', ' 12', '--1', '01'])(
    'shows a placeholder for %j, not NaN or 0',
    (value) => {
      const { container } = render(<Money tiyin={value} />, { wrapper: withLocale('uz') });
      expect(container.textContent).toBe('—');
    },
  );

  it('passes the design props through', () => {
    const { container } = render(<Money tiyin="150000" tone="credit" size="sm" />, {
      wrapper: withLocale('uz'),
    });
    expect(plain(container.textContent)).toBe('+1 500 so‘m');
  });
});

describe('useFormatMoney', () => {
  it('formats to full text with the unit in the active locale', () => {
    const uzText = renderHook(() => useFormatMoney()('1255000'), { wrapper: withLocale('uz') });
    const ruText = renderHook(() => useFormatMoney()('1255000'), { wrapper: withLocale('ru') });
    expect(plain(uzText.result.current)).toBe('12 550 so‘m');
    expect(plain(ruText.result.current)).toBe('12 550 сум');
  });

  it('returns the placeholder for a non-tiyin value', () => {
    const { result } = renderHook(() => useFormatMoney()('nope'), { wrapper: withLocale('uz') });
    expect(result.current).toBe('—');
  });
});

describe('formatTiyinString', () => {
  it('accepts only canonical signed integers', () => {
    expect(formatTiyinString('100', 'uz')).toBe('1');
    expect(formatTiyinString('-100', 'ru')).toBe('−1');
    expect(formatTiyinString('1.5', 'uz')).toBeNull();
    expect(formatTiyinString('', 'uz')).toBeNull();
  });
});
