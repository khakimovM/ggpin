import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { RecipientChecking } from '../RecipientChecking';

// The "Tekshirilmoqda" live region is mounted before the lookup starts and only its text changes:
// NVDA and JAWS do not read a `role="status"` that enters the DOM together with its text.

describe('<RecipientChecking>', () => {
  it('keeps the same live region node; only its text and the skeleton come and go', () => {
    const { rerender, container } = renderApp(<RecipientChecking active={false} />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass('sr-only');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    rerender(<RecipientChecking active />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Tekshirilmoqda');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    rerender(<RecipientChecking active={false} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('ru: the text comes from the catalog', () => {
    renderApp(<RecipientChecking active />, { locale: 'ru' });
    expect(screen.getByRole('status')).not.toBeEmptyDOMElement();
    expect(screen.getByRole('status')).not.toHaveTextContent('store.product');
  });
});
