import type { TopupCardView } from '@repo/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { PayBody } from '../PayBody';
import { PayCardBlock, isHiddenGroup } from '../PayCardBlock';

const CARD: TopupCardView = { bank: 'HUMO', number: '9860123456789012', holderName: 'ALISHER K.' };

function show(onCopy = vi.fn(), locale: 'uz' | 'ru' = 'uz') {
  const view = renderApp(<PayCardBlock card={CARD} copied={false} onCopy={onCopy} />, { locale });
  return { ...view, number: screen.getByTestId('pay-card-number') };
}

describe('PayCardBlock: the middle digits start hidden', () => {
  it('shows only the first and the last group, and the real middle digits are not in the page', () => {
    const { container, number } = show();
    expect(number).toHaveAccessibleName('9860, o‘rtadagi raqamlar yashirilgan, 9012');
    expect(number).toHaveTextContent(/^9860.*9012$/);
    // Neither in the text nor in an attribute: a blur over real digits could be undone.
    expect(container.innerHTML).not.toMatch(/1234|5678/);
    expect(number.querySelectorAll('[data-hidden]')).toHaveLength(2);
  });

  it('the eye button shows the full number and hides it again', () => {
    const { number } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Karta raqamini to‘liq ko‘rsatish' }));
    expect(number).toHaveAccessibleName('9860 1234 5678 9012');
    expect(number).toHaveTextContent('9860123456789012');
    expect(number.querySelectorAll('[data-hidden]')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Karta raqamini yashirish' }));
    expect(number).toHaveAccessibleName('9860, o‘rtadagi raqamlar yashirilgan, 9012');
    expect(number).not.toHaveTextContent(/1234|5678/);
  });

  it('the hidden groups are not digits: copied by hand they cannot pass for a card number', () => {
    const { number } = show();
    expect(number.textContent?.replace(/\D/g, '')).toBe('98609012');
  });

  it('copy puts the FULL number on the clipboard while the middle is hidden (the bank app needs it)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(<PayBody payAmountTiyin="5034700" card={CARD} msLeft={600_000} />);
    const block = screen.getByRole('region', { name: 'Karta raqami' });
    expect(within(block).getByTestId('pay-card-number')).not.toHaveTextContent(/1234|5678/);
    fireEvent.click(within(block).getByRole('button', { name: 'Nusxalash' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('9860123456789012'));
    expect(within(block).getByTestId('pay-card-number')).not.toHaveTextContent(/1234|5678/);
  });

  it('speaks Russian in ru', () => {
    const { number } = show(vi.fn(), 'ru');
    expect(number).toHaveAccessibleName('9860, средние цифры скрыты, 9012');
    expect(screen.getByRole('button', { name: 'Показать номер карты полностью' })).toBeVisible();
  });

  it('isHiddenGroup keeps the first and the last group of any length', () => {
    expect([0, 1, 2, 3].map((i) => isHiddenGroup(i, 4))).toEqual([false, true, true, false]);
    expect([0, 1].map((i) => isHiddenGroup(i, 2))).toEqual([false, false]);
    expect(isHiddenGroup(0, 1)).toBe(false);
  });
});
