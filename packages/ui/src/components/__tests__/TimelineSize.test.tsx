import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Timeline, type TimelineItem } from '../Timeline';

const LABELS = { done: 'Bajarildi', active: 'Joriy qadam', pending: 'Kutilmoqda' };
const view = (items: TimelineItem[], size?: 'md' | 'lg') => (
  <Timeline
    items={items}
    ariaLabel="Holat"
    stateLabels={LABELS}
    currentLabel="Joriy qadam"
    size={size}
  />
);
const STEPS: TimelineItem[] = [
  { id: 'paid', state: 'done', title: 'To‘landi', description: '14:02' },
  { id: 'queued', state: 'active', title: 'Navbatda' },
  { id: 'delivered', state: 'pending', title: 'Yetkazildi' },
];

afterEach(() => {
  delete document.documentElement.dataset.reduced;
});

describe('Timeline size', () => {
  it('md: 24 px dots and the time under the title', () => {
    const { container } = render(view(STEPS));
    const dots = [...container.querySelectorAll('[data-dot]')];
    expect(dots).toHaveLength(3);
    expect(dots.every((dot) => dot.className.includes('size-6'))).toBe(true);
    expect(screen.getAllByRole('listitem')[0]?.className).toContain('grid-cols-[24px_');
  });

  it('lg: 32 px dots, a third column and the time in it', () => {
    const { container } = render(view(STEPS, 'lg'));
    const dots = [...container.querySelectorAll('[data-dot]')];
    expect(dots.every((dot) => dot.className.includes('size-8'))).toBe(true);
    const first = screen.getAllByRole('listitem')[0];
    expect(first?.className).toContain('grid-cols-[32px_');
    expect(first?.lastElementChild).toHaveTextContent('14:02');
  });

  it('lg: a time that arrives later fades in (it is mounted then), the first paint does not', () => {
    const { rerender } = render(view(STEPS, 'lg'));
    const second = () => screen.getAllByRole('listitem')[1];
    expect(second()?.lastElementChild?.textContent).toBe(''); // the column is there, empty
    // First paint: the 14:02 that was already there is not hidden for a fade.
    expect(screen.getByText('14:02').style.opacity).not.toBe('0');

    rerender(
      view(
        [
          STEPS[0] as TimelineItem,
          { id: 'queued', state: 'active', title: 'Navbatda', description: '14:03' },
          STEPS[2] as TimelineItem,
        ],
        'lg',
      ),
    );
    expect(screen.getByText('14:03').style.opacity).toBe('0'); // starts transparent, animates to 1
  });

  it('lg under reduced motion: the time appears with no fade at all', () => {
    document.documentElement.dataset.reduced = 'true';
    const { rerender } = render(view(STEPS, 'lg'));
    rerender(
      view(
        [
          STEPS[0] as TimelineItem,
          { id: 'queued', state: 'active', title: 'Navbatda', description: '14:03' },
          STEPS[2] as TimelineItem,
        ],
        'lg',
      ),
    );
    expect(screen.getByText('14:03').style.opacity).not.toBe('0');
  });
});
