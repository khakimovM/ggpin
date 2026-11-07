import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, initialsOf } from '../Avatar';
import { Badge } from '../Badge';
import { Card } from '../Card';
import { Logo } from '../Logo';
import { MoneyText } from '../MoneyText';
import { RelativeTime } from '../RelativeTime';
import { Ribbon } from '../Ribbon';
import { StatusChip, type StatusChipStatus } from '../StatusChip';
import { StockChip } from '../StockChip';

describe('Logo', () => {
  it('takes the brand name from props and exposes it as the accessible name', () => {
    render(<Logo name="ggpin" variant="wordmark" size={34} />);
    expect(screen.getByRole('img', { name: 'ggpin' })).toBeInTheDocument();
  });

  it('draws the app mark with proportions from the design (96px -> radius 28)', () => {
    render(<Logo name="ggpin" size={96} />);
    const mark = screen.getByRole('img', { name: 'ggpin' });
    expect(mark).toHaveStyle({ width: '96px', height: '96px', borderRadius: '28px' });
  });

  it('is a circle for the bot avatar and a single accent g up to 20px', () => {
    const { rerender } = render(<Logo name="ggpin" variant="avatar" size={96} />);
    expect(screen.getByRole('img')).toHaveStyle({ borderRadius: '50%' });
    rerender(<Logo name="ggpin" size={16} />);
    expect(screen.getByRole('img')).toHaveTextContent(/^g$/);
  });
});

describe('MoneyText', () => {
  const NBSP = ' ';

  it('lays out a server-formatted amount and unit with a no-break space', () => {
    render(<MoneyText amount="12 550" unit="so‘m" />);
    expect(screen.getByText(/12 550/).textContent).toBe(`12 550${NBSP}so‘m`);
  });

  it('credits get a plus and the success colour; the amount is never reformatted', () => {
    render(<MoneyText amount="120 750" unit="сум" tone="credit" />);
    const node = screen.getByText(/120 750/);
    expect(node.textContent).toBe(`+120 750${NBSP}сум`);
    expect(node.className).toContain('text-success-text');
  });

  it('keeps the real minus of a negative amount and adds no plus', () => {
    render(<MoneyText amount="−61 500" unit="so‘m" tone="credit" />);
    expect(screen.getByText(/61 500/).textContent).toBe(`−61 500${NBSP}so‘m`);
  });

  it('uses tabular figures so columns and countdowns do not jitter', () => {
    render(<MoneyText amount="85 400" unit="so‘m" size="xl" />);
    expect(screen.getByText(/85 400/).className).toContain('tabular-nums');
  });
});

describe('RelativeTime', () => {
  it('prints what the caller-provided formatter returns and keeps the ISO value', () => {
    render(<RelativeTime value="2026-11-04T09:05:00.000Z" format={() => 'Bugun, 14:05'} />);
    const time = screen.getByText('Bugun, 14:05');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-11-04T09:05:00.000Z');
  });

  it('renders nothing for an invalid date instead of "Invalid Date"', () => {
    const { container } = render(<RelativeTime value="not a date" format={() => 'x'} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StatusChip', () => {
  const STATUSES: StatusChipStatus[] = [
    'PAID',
    'QUEUED',
    'PROCESSING',
    'NEEDS_REVIEW',
    'HELD',
    'DELIVERED',
    'FAILED',
    'REFUNDED',
    'CANCELLED',
  ];

  it.each(STATUSES)('%s shows its label next to an icon', (status) => {
    const { container } = render(<StatusChip status={status} label="Holat" />);
    expect(screen.getByText('Holat')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('uses the short label in tables and wraps the long one', () => {
    const { rerender } = render(
      <StatusChip
        status="REFUNDED"
        label="Не выполнено — деньги возвращены"
        shortLabel="Не выполнено"
      />,
    );
    expect(screen.getByText('Не выполнено — деньги возвращены')).toBeInTheDocument();
    rerender(
      <StatusChip
        status="REFUNDED"
        form="short"
        label="Не выполнено — деньги возвращены"
        shortLabel="Не выполнено"
      />,
    );
    expect(screen.getByText('Не выполнено')).toBeInTheDocument();
    expect(screen.getByText('Не выполнено').parentElement?.className).not.toContain(
      'whitespace-nowrap',
    );
  });

  it('only PROCESSING spins', () => {
    const { container, rerender } = render(<StatusChip status="PROCESSING" label="Bajarilmoqda" />);
    expect(
      container.querySelector('svg.animate-\\[gg-spin_900ms_linear_infinite\\]'),
    ).not.toBeNull();
    rerender(<StatusChip status="DELIVERED" label="Yetkazildi" />);
    expect(container.querySelector('svg.animate-\\[gg-spin_900ms_linear_infinite\\]')).toBeNull();
  });
});

describe('Badge, Ribbon, StockChip', () => {
  it('renders badge variants', () => {
    render(
      <>
        <Badge>Global</Badge>
        <Badge variant="popular">Mashhur</Badge>
        <Badge variant="soon">Tez orada</Badge>
      </>,
    );
    expect(screen.getByText('Mashhur').className).toContain('bg-accent');
    expect(screen.getByText('Tez orada').className).toContain('bg-elevated');
  });

  it('hangs the ribbon from the end by default (safe for long Russian text), start on request', () => {
    const { rerender } = render(<Ribbon>Выгоднее всего</Ribbon>);
    expect(screen.getByText('Выгоднее всего').className).toContain('right-3');
    rerender(<Ribbon anchor="start">Eng foydali</Ribbon>);
    expect(screen.getByText('Eng foydali').className).toContain('left-3');
  });

  it('stock chip states carry text, not only colour', () => {
    const { rerender } = render(<StockChip state="low" label="69 ta qoldi" />);
    expect(screen.getByText('69 ta qoldi')).toHaveAttribute('data-stock', 'low');
    rerender(<StockChip state="soldOut" label="Tugagan" />);
    expect(screen.getByText('Tugagan')).toHaveAttribute('data-stock', 'soldOut');
  });
});

describe('Card and Avatar', () => {
  it('a card can become a link and keeps the card look', () => {
    render(
      <Card asChild interactive>
        <a href="/store/products/stars">Telegram Stars</a>
      </Card>,
    );
    const link = screen.getByRole('link', { name: 'Telegram Stars' });
    expect(link.className).toContain('bg-card');
    expect(link.className).toContain('rounded-lg');
  });

  it('builds initials from the first and last word of the name', () => {
    expect(initialsOf('Sardor Rahimov')).toBe('SR');
    expect(initialsOf('Dilnoza')).toBe('D');
    expect(initialsOf('  ')).toBe('');
  });

  it('is one named image for assistive tech, and decoration without a name', () => {
    const { container, rerender } = render(<Avatar name="Sardor Rahimov" />);
    expect(screen.getByRole('img', { name: 'Sardor Rahimov' })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(1);
    rerender(<Avatar />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the 44 px of the Mini App profile line, with its 15 px initials', () => {
    render(<Avatar name="Sardor" size={44} />);
    const avatar = screen.getByRole('img', { name: 'Sardor' });
    expect(avatar).toHaveStyle({ width: '44px', height: '44px' });
    expect(avatar.firstElementChild?.className).toContain('text-[15px]');
  });

  it('falls back to initials when there is no photo', () => {
    render(<Avatar name="Sardor Rahimov" size={40} />);
    expect(screen.getByLabelText('Sardor Rahimov')).toHaveTextContent('SR');
  });
});
