import type { CatalogSku } from '@repo/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { RecipientWarnings, knownWarningKeys } from '../RecipientWarnings';
import { SkuGrid } from '../SkuGrid';
import { planValues } from '../plan-value';

// Phase 6 P6-W1: the non-blocking "already has Premium" note and the Premium term rows
// ("{price}/oy" and "Eng foydali", owner decision Q6).

const EXTENDS = { code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' };
const sku = (id: string, quantity: number, price: string | null): CatalogSku => ({
  id,
  label: `${quantity} oylik`,
  quantity,
  tab: null,
  fromPriceTiyin: price,
});
const TERMS = [sku('m3', 3, '16500000'), sku('m6', 6, '22000000'), sku('m12', 12, '39600000')];
// NBSP and narrow NBSP are layout; compare with plain spaces.
const plain = (text: string | null): string => (text ?? '').replace(/[\s\p{Z}]+/gu, ' ').trim();

describe('<RecipientWarnings>', () => {
  it.each([
    ['uz', 'Bu foydalanuvchida Premium allaqachon bor. Sovg‘a muddatni uzaytiradi.'],
    ['ru', 'У этого пользователя уже есть Premium. Подарок продлит срок.'],
  ] as const)('%s: PREMIUM_EXTENDS is a status note with its catalog text', (locale, text) => {
    renderApp(<RecipientWarnings warnings={[EXTENDS]} />, { locale });
    expect(screen.getByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing for a code whose message is not in the catalog, and never a raw key', () => {
    const unknown = [
      { code: 'SOMETHING_NEW', message: 'warnings.somethingNew' },
      { code: 'PREMIUM_EXTENDS', message: 'warnings.toString' },
    ];
    const { container } = renderApp(<RecipientWarnings warnings={unknown} />);
    expect(container).toBeEmptyDOMElement();
    expect(knownWarningKeys(unknown)).toEqual([]);
  });

  it('shows a known warning once, next to unknown ones', () => {
    const warnings = [{ code: 'X', message: 'warnings.x' }, EXTENDS, EXTENDS];
    renderApp(<RecipientWarnings warnings={warnings} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(knownWarningKeys(warnings)).toEqual(['premiumExtends']);
  });

  it('renders nothing for an empty list', () => {
    const { container } = renderApp(<RecipientWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('planValues', () => {
  it('per month rounded up to 100 so‘m; the lowest per month is the best', () => {
    const { perMonth, best } = planValues(TERMS);
    expect(Object.fromEntries(perMonth)).toEqual({
      m3: '5500000',
      m6: '3670000', // 36 666.67 so'm -> 36 700, never 36 600
      m12: '3300000',
    });
    expect(best).toBe('m12');
  });

  it('a tie goes to the longer term', () => {
    expect(planValues([sku('m6', 6, '19800000'), sku('m12', 12, '39600000')]).best).toBe('m12');
    expect(planValues([sku('m12', 12, '39600000'), sku('m6', 6, '19800000')]).best).toBe('m12');
  });

  it('no best with fewer than two priced terms; a term without a price has no per-month line', () => {
    expect(planValues([sku('m3', 3, '16500000')]).best).toBeNull();
    const partial = planValues([sku('m3', 3, '16500000'), sku('m6', 6, null)]);
    expect(partial.best).toBeNull();
    expect(partial.perMonth.has('m6')).toBe(false);
    expect(planValues([]).best).toBeNull();
  });

  it('a free term is neither laid out nor the best (m3 of the W1 review)', () => {
    const plans = planValues([
      sku('m3', 3, '0'),
      sku('m6', 6, '19800000'),
      sku('m12', 12, '39600000'),
    ]);
    expect(plans.perMonth.has('m3')).toBe(false);
    expect(plans.best).toBe('m12');
  });
});

describe('<SkuGrid> terms', () => {
  const grid = (layout: 'grid' | 'list', locale: 'uz' | 'ru' = 'uz', skus = TERMS) =>
    renderApp(
      <SkuGrid
        skus={skus}
        selected={null}
        onSelect={() => {}}
        ariaLabel="Muddat"
        layout={layout}
      />,
      { locale },
    );

  it.each([
    ['uz', '36 700 so‘m/oy', 'Eng foydali'],
    ['ru', '36 700 сум/мес', 'Выгоднее всего'],
  ] as const)(
    '%s: a per-month line on every term, the ribbon on the best one',
    (locale, m6, best) => {
      grid('list', locale);
      const radios = screen.getAllByRole('radio');
      expect(plain(radios[1]?.textContent ?? null)).toContain(m6);
      expect(radios[2]).toHaveTextContent(best);
      expect(within(radios[0] as HTMLElement).queryByText(best)).toBeNull();
      expect(within(radios[1] as HTMLElement).queryByText(best)).toBeNull();
    },
  );

  it('packages (grid) get neither a per-month line nor a ribbon', () => {
    grid('grid');
    expect(screen.queryByText('Eng foydali')).toBeNull();
    expect(screen.queryByText(/\/oy/)).toBeNull();
  });
});
