import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Accordion } from '../Accordion';
import { Chip } from '../Chip';
import { SegmentedControl } from '../SegmentedControl';
import { Tabs } from '../Tabs';

describe('Chip', () => {
  it('filter chips expose their selected state through aria-pressed', () => {
    const { rerender } = render(<Chip>Yetkazildi</Chip>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    rerender(<Chip selected>Yetkazildi</Chip>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('lets long Russian labels wrap instead of overflowing', () => {
    render(<Chip>Не выполнено — деньги возвращены</Chip>);
    expect(screen.getByRole('button').className).not.toContain('whitespace-nowrap');
  });

  it('removable chips call onRemove from a named button', async () => {
    const onRemove = vi.fn();
    render(
      <Chip variant="removable" onRemove={onRemove} removeLabel="Olib tashlash">
        PUBG Mobile
      </Chip>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Olib tashlash' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('quick chips do not claim a pressed state unless selected', () => {
    render(<Chip variant="quick">+50 000</Chip>);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed');
  });
});

describe('Chip accessibility contract', () => {
  it('a remove handler without an accessible name does not compile', () => {
    const never = () => {
      // @ts-expect-error removable needs removeLabel: an icon-only button must have a name
      return <Chip variant="removable" onRemove={() => undefined} />;
    };
    expect(never).toBeTypeOf('function');
  });

  it('a removeLabel on a chip that cannot be removed does not compile either', () => {
    const never = () => {
      // @ts-expect-error removeLabel only belongs to variant="removable"
      return <Chip removeLabel="Olib tashlash">x</Chip>;
    };
    expect(never).toBeTypeOf('function');
  });

  it('keeps a 44px target: the 36px chip grows a pseudo-element hit area', () => {
    render(<Chip>Yetkazildi</Chip>);
    const classes = screen.getByRole('button').className;
    expect(classes).toContain('min-h-9');
    expect(classes).toContain('before:h-11');
  });
});

const OPTIONS = [
  { value: 'orders', label: 'Buyurtmalar' },
  { value: 'finance', label: 'Moliya' },
] as const;

function SegmentedHarness() {
  const [value, setValue] = useState<'orders' | 'finance'>('orders');
  return (
    <SegmentedControl options={OPTIONS} value={value} onValueChange={setValue} ariaLabel="Bo‘lim" />
  );
}

describe('SegmentedControl', () => {
  it('marks the current option and changes it on click', async () => {
    render(<SegmentedHarness />);
    expect(screen.getByRole('radio', { name: 'Buyurtmalar' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Moliya' }));
    expect(screen.getByRole('radio', { name: 'Moliya' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Buyurtmalar' })).not.toBeChecked();
  });

  it('cannot be left without a selection by pressing the selected option again', async () => {
    render(<SegmentedHarness />);
    await userEvent.click(screen.getByRole('radio', { name: 'Buyurtmalar' }));
    expect(screen.getByRole('radio', { name: 'Buyurtmalar' })).toBeChecked();
  });

  it('moves with the arrow keys', async () => {
    render(<SegmentedHarness />);
    screen.getByRole('radio', { name: 'Buyurtmalar' }).focus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(screen.getByRole('radio', { name: 'Moliya' })).toBeChecked();
  });
});

describe('Tabs', () => {
  function Harness() {
    const [value, setValue] = useState('all');
    return (
      <Tabs
        ariaLabel="Kategoriyalar"
        value={value}
        onValueChange={setValue}
        items={[
          { value: 'all', label: 'Hammasi', content: <p>Barcha mahsulotlar</p> },
          { value: 'games', label: 'O‘yinlar', content: <p>O‘yin mahsulotlari</p> },
        ]}
      />
    );
  }

  it('shows the panel of the selected tab and switches with the keyboard', async () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Hammasi' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Barcha mahsulotlar')).toBeVisible();
    screen.getByRole('tab', { name: 'Hammasi' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'O‘yinlar' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('O‘yin mahsulotlari')).toBeVisible();
  });
});

describe('Accordion', () => {
  const items = [
    {
      value: 'time',
      question: 'Buyurtma qancha vaqtda yetkaziladi?',
      answer: 'Odatda 1–2 daqiqa.',
    },
    {
      value: 'refund',
      question: 'Buyurtma bajarilmasa-chi?',
      answer: 'Pul avtomatik qaytariladi.',
    },
  ];

  it('opens one answer at a time and closes it again', async () => {
    render(<Accordion items={items} />);
    const first = screen.getByRole('button', { name: items[0]?.question as string });
    const second = screen.getByRole('button', { name: items[1]?.question as string });
    expect(first).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Odatda 1–2 daqiqa.')).toBeInTheDocument();
    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveAttribute('aria-expanded', 'false');
  });
});
