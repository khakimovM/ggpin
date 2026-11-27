import { PER_MONTH_DISPLAY_STEP_TIYIN, perUnitDisplayTiyin, type CatalogSku } from '@repo/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { PackageSection } from '../PackageSection';
import { RecipientWarnings, knownWarningKeys } from '../RecipientWarnings';
import { SkuGrid } from '../SkuGrid';
import { planValues } from '../plan-value';
import { PREMIUM, STARS } from './product-test-kit';

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
    renderApp(<RecipientWarnings warnings={unknown} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(knownWarningKeys(unknown)).toEqual([]);
  });

  it('shows a known warning once, next to unknown ones', () => {
    const warnings = [{ code: 'X', message: 'warnings.x' }, EXTENDS, EXTENDS];
    renderApp(<RecipientWarnings warnings={warnings} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(knownWarningKeys(warnings)).toEqual(['premiumExtends']);
  });

  it('an empty list keeps an empty live region (no box, no text)', () => {
    renderApp(<RecipientWarnings warnings={[]} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('the live region stays the same node and only its content changes (NVDA/JAWS)', () => {
    const { rerender } = renderApp(<RecipientWarnings warnings={[]} />);
    const region = screen.getByRole('status');
    rerender(<RecipientWarnings warnings={[EXTENDS]} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Sovg‘a muddatni uzaytiradi.');
    rerender(<RecipientWarnings warnings={[]} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
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

  it('a tie made by rounding goes to the longer term too', () => {
    // 220 000 so'm / 6 and 440 000 so'm / 12 are both 36 666.67 so'm a month: different sums that
    // the money module rounds up to the same shown 36 700 so'm, so the longer term is the best.
    const m6 = perUnitDisplayTiyin(22_000_000n, 6, PER_MONTH_DISPLAY_STEP_TIYIN);
    const m12 = perUnitDisplayTiyin(44_000_000n, 12, PER_MONTH_DISPLAY_STEP_TIYIN);
    expect(m6).toBe(3_670_000n);
    expect(m12).toBe(m6);
    const plans = planValues([sku('m6', 6, '22000000'), sku('m12', 12, '44000000')]);
    expect(Object.fromEntries(plans.perMonth)).toEqual({ m6: '3670000', m12: '3670000' });
    expect(plans.best).toBe('m12');
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
        perMonth={layout === 'list'}
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

describe('<PackageSection> title, per-month line and ribbon', () => {
  const section = (product: typeof STARS, locale: 'uz' | 'ru' = 'uz') =>
    renderApp(
      <PackageSection
        product={product}
        selectedSku={null}
        customQty=""
        onSelectSku={() => {}}
        onQtyChange={() => {}}
      />,
      { locale },
    );
  const title = () => screen.getByRole('heading', { level: 2 });

  it.each([
    ['uz', 'Paketni tanlang', 'Muddat', 'Miqdor'],
    ['ru', 'Выберите пакет', 'Срок', 'Количество'],
  ] as const)('%s: "Muddat" only for Premium terms', (locale, packages, terms, quantity) => {
    const stars = section({ ...STARS, allowCustomQty: false }, locale);
    expect(title()).toHaveTextContent(packages);
    expect(screen.getByRole('radiogroup', { name: packages })).toBeInTheDocument();
    stars.unmount();
    const premium = section(PREMIUM, locale);
    expect(title()).toHaveTextContent(terms);
    expect(screen.getByRole('radiogroup', { name: terms })).toBeInTheDocument();
    premium.unmount();
    // Stars with a free quantity keep the "Miqdor" section as before.
    section(STARS, locale);
    expect(title()).toHaveTextContent(quantity);
  });

  it('Stars packages in the list layout get neither "/oy" nor "Eng foydali"', () => {
    // A Telegram product without a free quantity is laid out as a list, like Premium terms.
    section({ ...STARS, allowCustomQty: false });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByText(/\/oy/)).toBeNull();
    expect(screen.queryByText('Eng foydali')).toBeNull();
  });

  it('Premium terms keep their per-month line and the ribbon', () => {
    section(PREMIUM);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getAllByText(/\/oy/)).toHaveLength(3);
    expect(radios[2]).toHaveTextContent('Eng foydali');
    expect(screen.getAllByText('Eng foydali')).toHaveLength(1);
  });
});
