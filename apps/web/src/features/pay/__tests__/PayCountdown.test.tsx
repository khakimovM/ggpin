import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { PayCountdown } from '../PayCountdown';

describe('PayCountdown', () => {
  it('is a timer on a div: <section> does not allow the timer role (axe aria-allowed-role)', () => {
    renderApp(<PayCountdown msLeft={29 * 60 * 1000} />);
    const timer = screen.getByRole('timer');
    expect(timer.tagName).toBe('DIV');
    expect(timer).toHaveAttribute('aria-live', 'off');
    expect(timer).not.toHaveAttribute('data-low');
    expect(timer).toHaveTextContent(uz.pay.timeLabel);
    expect(timer).not.toHaveTextContent(uz.pay.lowLeft);
  });

  it('under five minutes it says so in words and carries the low marker', () => {
    renderApp(<PayCountdown msLeft={4 * 60 * 1000} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveAttribute('data-low', '');
    expect(timer).toHaveTextContent(uz.pay.lowLeft);
    expect(timer).not.toHaveTextContent(uz.pay.timeLabel);
  });

  it('Russian: the same words in Russian', () => {
    renderApp(<PayCountdown msLeft={4 * 60 * 1000} />, { locale: 'ru' });
    expect(screen.getByRole('timer')).toHaveTextContent(ru.pay.lowLeft);
  });
});
