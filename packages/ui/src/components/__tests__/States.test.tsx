import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inbox } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { mockMatchMedia } from '../../../test/match-media';
import { EmptyState } from '../EmptyState';
import { ErrorState } from '../ErrorState';
import { Icon } from '../Icon';
import { Skeleton } from '../Skeleton';
import { Timeline, type TimelineItem } from '../Timeline';

// The shimmer is the only animated child of a skeleton block.
const shimmerOf = (container: HTMLElement) => container.querySelector('span > span');

describe('Skeleton', () => {
  it('is hidden from assistive tech and shimmers by default', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(shimmerOf(container)).not.toBeNull();
  });

  it('is a static fill when the profile switch asks for reduced motion', () => {
    document.documentElement.dataset.reduced = 'true';
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(shimmerOf(container)).toBeNull();
  });

  it('is a static fill when the OS asks for reduced motion', () => {
    mockMatchMedia((query) => query.includes('prefers-reduced-motion'));
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(shimmerOf(container)).toBeNull();
  });

  it('switches off the shimmer live when data-reduced changes', async () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    expect(shimmerOf(container)).not.toBeNull();
    await act(async () => {
      document.documentElement.dataset.reduced = 'true';
      await Promise.resolve();
    });
    expect(shimmerOf(container)).toBeNull();
  });
});

describe('EmptyState', () => {
  it('shows the icon, the line and the call to action', () => {
    render(
      <EmptyState
        icon={<Icon icon={Inbox} size={24} />}
        title="Hali buyurtma yo‘q"
        description="Birinchi xaridingiz shu yerda ko‘rinadi"
        action={<button>Xarid qilish</button>}
      />,
    );
    expect(screen.getByText('Hali buyurtma yo‘q')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xarid qilish' })).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('announces the failure and retries on click', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Yuklab bo‘lmadi" retryLabel="Qayta urinish" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Yuklab bo‘lmadi');
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('blocks a second retry while retrying (aria-busy, focus kept)', () => {
    render(
      <ErrorState
        title="Yuklab bo‘lmadi"
        retryLabel="Qayta urinish"
        onRetry={() => undefined}
        retrying
      />,
    );
    const retry = screen.getByRole('button', { name: 'Qayta urinish' });
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
  });
});

const STEPS: TimelineItem[] = [
  { id: 'accepted', state: 'done', title: 'Buyurtma qabul qilindi', description: 'Bugun, 14:02' },
  { id: 'paid', state: 'done', title: 'Hamyondan yechildi' },
  { id: 'sending', state: 'active', title: '@jasur_t ga yuborilmoqda' },
  { id: 'delivered', state: 'pending', title: 'Yetkazildi' },
];

const STATE_LABELS = { done: 'Bajarildi', active: 'Joriy qadam', pending: 'Kutilmoqda' };

function renderTimeline(items: TimelineItem[]) {
  return (
    <Timeline
      items={items}
      ariaLabel="Buyurtma holati"
      stateLabels={STATE_LABELS}
      currentLabel="Joriy qadam"
    />
  );
}

const advance = (items: TimelineItem[]): TimelineItem[] =>
  items.map((step) =>
    step.id === 'sending'
      ? { ...step, state: 'done' as const }
      : step.id === 'delivered'
        ? { ...step, state: 'active' as const }
        : step,
  );

describe('Timeline', () => {
  it('renders every step with its state and marks the active one as the current step', () => {
    render(renderTimeline(STEPS));
    const list = screen.getByRole('list', { name: 'Buyurtma holati' });
    // Only the dedicated status region is live: an aria-live list would re-read every step.
    expect(list).not.toHaveAttribute('aria-live');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ]);
    expect(rows[2]).toHaveAttribute('aria-current', 'step');
    expect(rows[3]).not.toHaveAttribute('aria-current');
  });

  it('speaks the state of every step, not only shows it with colour and icons', () => {
    render(renderTimeline(STEPS));
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Bajarildi: Buyurtma qabul qilindi');
    expect(rows[2]).toHaveTextContent('Joriy qadam: @jasur_t ga yuborilmoqda');
    expect(rows[3]).toHaveTextContent('Kutilmoqda: Yetkazildi');
    expect(within(rows[3] as HTMLElement).getByText(/Kutilmoqda/)).toHaveClass('sr-only');
  });

  it('announces the current step in a separate polite status region', () => {
    const { rerender } = render(renderTimeline(STEPS));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Joriy qadam: @jasur_t ga yuborilmoqda');
    expect(status).toHaveClass('sr-only');
    rerender(renderTimeline(advance(STEPS)));
    expect(screen.getByRole('status')).toHaveTextContent('Joriy qadam: Yetkazildi');
  });

  it('announces the last finished step once everything is done', () => {
    render(renderTimeline(STEPS.map((step) => ({ ...step, state: 'done' as const }))));
    expect(screen.getByRole('status')).toHaveTextContent('Joriy qadam: Yetkazildi');
  });

  it('moves to the next step when the items change', () => {
    const { rerender } = render(renderTimeline(STEPS));
    rerender(renderTimeline(advance(STEPS)));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'active',
    ]);
    expect(rows[3]).toHaveAttribute('aria-current', 'step');
  });
});
