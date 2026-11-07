import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCatalogSearchStore } from '../../../stores/catalog-search-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { SEARCH_DEBOUNCE_MS } from '../../catalog/use-catalog-search';
import { useSearchUrlSync } from '../use-search-url-sync';

// The rule of useSearchUrlSync: entering the catalog, or the address changing on it, takes the box
// FROM the address; writing happens only when the search itself changed, and only as a real
// navigation. Every test below is a sequence a visitor can produce with the keyboard and the
// browser's back button.

const nav = vi.hoisted(() => ({
  pathname: '/store',
  search: '',
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const store = () => useCatalogSearchStore.getState();
const text = () => store().text;

function Sync() {
  useSearchUrlSync();
  return null;
}
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 150)));

beforeEach(() => {
  nav.pathname = '/store';
  nav.search = '';
  nav.replace.mockReset();
  nav.push.mockReset();
  useCatalogSearchStore.setState({ text: '' });
});

describe('coming back to the catalog after the box was changed elsewhere', () => {
  it('cleared on the profile, then "back" to /store?q=x: the box follows the address', async () => {
    nav.search = 'q=x';
    const { rerender } = renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();

    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    // The X button on the profile: the box empties, no navigation is made.
    act(() => store().clear());
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();

    nav.pathname = '/store';
    nav.search = 'q=x';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a history entry is not rewritten by a write that never navigated', async () => {
    // /store -> profile -> "x" (push /store?q=x) -> profile -> box cleared -> back (/store?q=x)
    // -> back twice (/store). Nothing in between may call replace.
    nav.pathname = '/store/profile';
    const { rerender } = renderApp(<Sync />);
    act(() => store().setText('x'));
    await settle();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/store?q=x', { scroll: false });

    nav.pathname = '/store';
    nav.search = 'q=x';
    rerender(<Sync />);
    await settle();

    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    act(() => store().clear());
    await settle();

    nav.pathname = '/store';
    nav.search = 'q=x';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();

    nav.search = '';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe(''));
    await settle();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});

describe('a header mounted afresh over an old text', () => {
  it('takes the box from the address (empty), and writes nothing', async () => {
    // Left the store layout and came back by client navigation: the store still holds the old text.
    useCatalogSearchStore.setState({ text: 'old' });
    renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe(''));
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
