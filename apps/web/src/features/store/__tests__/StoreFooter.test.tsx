import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { StoreFooter } from '../StoreFooter';

afterEach(() => {
  vi.useRealTimers();
});

describe('StoreFooter', () => {
  it('the year is the one in Uzbekistan: 20:00 UTC on 31 December is already the new year there', () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T20:00:00Z'), toFake: ['Date'] });
    renderApp(<StoreFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/© 2026 /);
  });

  it('and the old year while it is still the old year there', () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T18:59:00Z'), toFake: ['Date'] });
    renderApp(<StoreFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/© 2025 /);
  });
});
