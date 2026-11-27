import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackagePicker, type PackageOption } from '../PackagePicker';

const OPTIONS: PackageOption[] = [
  { id: 'a', label: '50 ⭐', price: '11 000 so‘m', cta: 'Sotib olish · 11 000 so‘m' },
  { id: 'b', label: '500 ⭐', price: '110 000 so‘m', cta: 'Sotib olish · 110 000 so‘m' },
  { id: 'c', label: '1000 ⭐', price: null, cta: 'Sotib olish' },
];
const NOTE = 'Narx taxminiy, aniq narx xarid paytida.';

function draw(options: readonly PackageOption[] = OPTIONS) {
  return render(
    <PackagePicker
      label="Stars miqdori"
      amountHeading="Miqdor"
      priceHeading="Narx"
      options={options}
      notes={[NOTE]}
      buyHref="/store/products/telegram-stars"
    >
      <a href="https://t.me/test_bot">Telegramʼda</a>
    </PackagePicker>,
  );
}

const radios = () =>
  within(screen.getByRole('radiogroup', { name: 'Stars miqdori' })).getAllByRole('radio');
const radio = (index: number): HTMLElement => {
  const found = radios()[index];
  if (found === undefined) throw new Error(`no radio ${index}`);
  return found;
};

describe('PackagePicker', () => {
  it('is a radiogroup with the first package chosen and one tab stop', () => {
    draw();
    expect(radio(0)).toHaveAttribute('aria-checked', 'true');
    expect(radio(1)).toHaveAttribute('aria-checked', 'false');
    expect(radio(0)).toHaveAttribute('tabindex', '0');
    expect(radio(1)).toHaveAttribute('tabindex', '-1');
    expect(radio(2)).toHaveAttribute('tabindex', '-1');
  });

  it('shows the strings it was given, and no price for a package without one', () => {
    draw();
    expect(radio(0)).toHaveTextContent('50 ⭐');
    expect(radio(0)).toHaveTextContent('11 000 so‘m');
    expect(radio(2)).toHaveTextContent('1000 ⭐');
    expect(radio(2).textContent).not.toMatch(/so‘m/);
  });

  it("the buy button carries the chosen package's price and leads to the store", async () => {
    const user = userEvent.setup();
    draw();
    const buy = () => screen.getByRole('link', { name: /Sotib olish/ });
    expect(buy()).toHaveTextContent('Sotib olish · 11 000 so‘m');
    expect(buy()).toHaveAttribute('href', '/store/products/telegram-stars');
    await user.click(radio(1));
    expect(radio(1)).toHaveAttribute('aria-checked', 'true');
    expect(radio(0)).toHaveAttribute('aria-checked', 'false');
    expect(buy()).toHaveTextContent('Sotib olish · 110 000 so‘m');
    // A package with no price: the button says only what it does.
    await user.click(radio(2));
    expect(buy()).toHaveTextContent(/^Sotib olish$/);
  });

  it('the arrows move the choice and the focus, wrapping at the ends', async () => {
    const user = userEvent.setup();
    draw();
    radio(0).focus();
    await user.keyboard('{ArrowDown}');
    expect(radio(1)).toHaveAttribute('aria-checked', 'true');
    expect(radio(1)).toHaveFocus();
    expect(radio(1)).toHaveAttribute('tabindex', '0');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(radio(0)).toHaveAttribute('aria-checked', 'true');
    expect(radio(0)).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(radio(2)).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(radio(1)).toHaveAttribute('aria-checked', 'true');
  });

  it('Home and End jump to the first and the last', async () => {
    const user = userEvent.setup();
    draw();
    radio(0).focus();
    await user.keyboard('{End}');
    expect(radio(2)).toHaveAttribute('aria-checked', 'true');
    expect(radio(2)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(radio(0)).toHaveAttribute('aria-checked', 'true');
    expect(radio(0)).toHaveFocus();
  });

  it('Space chooses the focused package; other keys do nothing', async () => {
    const user = userEvent.setup();
    draw();
    radio(1).focus();
    await user.keyboard('a');
    expect(radio(0)).toHaveAttribute('aria-checked', 'true');
    await user.keyboard(' ');
    expect(radio(1)).toHaveAttribute('aria-checked', 'true');
  });

  it('a single package still works: the arrows stay on it', async () => {
    const user = userEvent.setup();
    draw(OPTIONS.slice(0, 1));
    radio(0).focus();
    await user.keyboard('{ArrowDown}');
    expect(radio(0)).toHaveAttribute('aria-checked', 'true');
    expect(radio(0)).toHaveFocus();
  });

  it('with no package it draws nothing: no empty group, no buy button without a label', () => {
    const { container } = draw([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the notes and the buttons given to it', () => {
    draw();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Telegramʼda' })).toBeInTheDocument();
  });

  it('does no arithmetic and no formatting, and imports nothing from the shared barrel', () => {
    const source = readFileSync(join(__dirname, '..', 'PackagePicker.tsx'), 'utf8');
    expect(source).not.toMatch(
      /\bNumber\(|parseInt|parseFloat|Intl\.|toFixed|toLocaleString|@repo\/shared/,
    );
  });
});
