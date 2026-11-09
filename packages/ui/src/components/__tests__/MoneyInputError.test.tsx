import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MoneyInput } from '../MoneyInput';

const base = {
  label: 'Summa',
  unit: 'so‘m',
  onValueChange: () => undefined,
  min: '5000',
  max: '2000000',
  minError: 'Minimal summa 5 000 so‘m',
  help: '5 000 so‘mdan 2 000 000 so‘mgacha',
};

describe('MoneyInput error prop', () => {
  it('shows the caller error as an alert, even on an empty field, and marks the field invalid', () => {
    render(<MoneyInput {...base} value="" error="Summa 1 000 so‘mga karrali bo‘lsin" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Summa 1 000 so‘mga karrali bo‘lsin');
    expect(screen.getByLabelText('Summa')).toHaveAttribute('aria-invalid', 'true');
  });

  it('wins over the min/max text', () => {
    render(<MoneyInput {...base} value="100" error="Bugungi limit tugadi" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Bugungi limit tugadi');
    expect(screen.queryByText('Minimal summa 5 000 so‘m')).toBeNull();
  });

  it('without it the limits still speak, and the help shows when all is well', () => {
    const { rerender } = render(<MoneyInput {...base} value="100" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Minimal summa 5 000 so‘m');
    rerender(<MoneyInput {...base} value="50000" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('5 000 so‘mdan 2 000 000 so‘mgacha')).toBeInTheDocument();
  });
});
