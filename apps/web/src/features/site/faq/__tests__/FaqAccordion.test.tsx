import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FaqAccordion, type FaqItem } from '../FaqAccordion';

const ITEMS: FaqItem[] = [
  { question: 'First?', answer: 'The first answer.' },
  { question: 'Second?', answer: 'The second answer.' },
  { question: 'Third?', answer: 'The third answer.' },
];

const details = (container: HTMLElement) => [...container.querySelectorAll('details')];

describe('FaqAccordion', () => {
  it('opens the first item and leaves the others closed', () => {
    const { container } = render(<FaqAccordion items={ITEMS} />);
    expect(details(container).map((item) => item.open)).toEqual([true, false, false]);
  });

  it('can start with every item closed, or with another one open', () => {
    const closed = render(<FaqAccordion items={ITEMS} openIndex={null} />);
    expect(details(closed.container).map((item) => item.open)).toEqual([false, false, false]);
    closed.unmount();
    const second = render(<FaqAccordion items={ITEMS} openIndex={1} />);
    expect(details(second.container).map((item) => item.open)).toEqual([false, true, false]);
  });

  it('puts every item in one named group, so a browser keeps a single item open', () => {
    const { container } = render(<FaqAccordion items={ITEMS} group="landing-faq" />);
    expect(details(container).map((item) => item.getAttribute('name'))).toEqual([
      'landing-faq',
      'landing-faq',
      'landing-faq',
    ]);
  });

  it('keeps every answer in the document, closed or not (a crawler reads them all)', () => {
    render(<FaqAccordion items={ITEMS} />);
    for (const item of ITEMS) expect(screen.getByText(item.answer)).toBeInTheDocument();
  });

  it('names each question as a heading inside its summary', () => {
    render(<FaqAccordion items={ITEMS} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(
      ITEMS.map((item) => item.question),
    );
    for (const heading of screen.getAllByRole('heading', { level: 3 })) {
      expect(heading.closest('summary')).not.toBeNull();
    }
  });

  it('toggles an item from its summary', async () => {
    const user = userEvent.setup();
    const { container } = render(<FaqAccordion items={ITEMS} />);
    const [first] = details(container);
    expect(first?.open).toBe(true);
    const summary = first?.querySelector('summary');
    if (summary === null || summary === undefined) throw new Error('no summary');
    await user.click(summary);
    expect(first?.open).toBe(false);
  });
});
