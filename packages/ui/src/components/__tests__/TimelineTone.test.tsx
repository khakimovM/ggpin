import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Timeline, type TimelineItem } from '../Timeline';

const LABELS = { done: 'Bajarildi', active: 'Joriy qadam', pending: 'Kutilmoqda' };

function view(items: TimelineItem[]) {
  return render(
    <Timeline items={items} ariaLabel="Holat" stateLabels={LABELS} currentLabel="Joriy qadam" />,
  );
}

describe('Timeline tones', () => {
  it('a toned step keeps its state for assistive tech and draws its own icon, not the plain check', () => {
    const { container } = view([
      { id: 'paid', state: 'done', title: 'To‘landi' },
      { id: 'failed', state: 'done', tone: 'danger', title: 'Bajarilmadi' },
      { id: 'refunded', state: 'done', tone: 'refund', title: 'Pul qaytarildi' },
    ]);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['done', 'done', 'done']);
    // The state is spoken for every step, toned or not.
    expect(screen.getAllByText('Bajarildi:', { exact: false })).toHaveLength(3);
    const icons = rows.map((row) => row.querySelector('svg')?.getAttribute('class') ?? '');
    expect(new Set(icons).size).toBeGreaterThan(1);
    expect(container.querySelector('.bg-danger')).not.toBeNull();
  });

  it('an active step under review stops spinning: a static icon, the title says what it is', () => {
    const { container } = view([
      { id: 'paid', state: 'done', title: 'To‘landi' },
      { id: 'review', state: 'active', tone: 'warning', title: 'Tekshirilmoqda' },
      { id: 'delivered', state: 'pending', title: 'Yetkazildi' },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Joriy qadam: Tekshirilmoqda');
    expect(container.querySelector('.bg-warning')).not.toBeNull();
    expect(container.querySelector('[class*="gg-pulse"]')).toBeNull();
  });
});
