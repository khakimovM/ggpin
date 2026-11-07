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

describe('load and typing', () => {
  it('a ?q= in the address fills the box, and the address is left alone', async () => {
    nav.search = 'q=pubg&category=games';
    renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('pubg'));
    await settle();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('typing writes ?q= after the debounce, keeping the other parameters', async () => {
    nav.search = 'category=games';
    renderApp(<Sync />);
    act(() => store().setText('  steam '));
    expect(nav.replace).not.toHaveBeenCalled();
    await settle();
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('/store?category=games&q=steam', { scroll: false });
  });

  it('clearing removes ?q= and keeps the rest', async () => {
    nav.search = 'q=steam&category=games';
    renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('steam'));
    await settle();
    act(() => store().clear());
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/store?category=games', { scroll: false }),
    );
  });

  it('a hostile ?q= is sanitised before it reaches the box', async () => {
    nav.search = `q=${encodeURIComponent('  a\u0000b  ')}`;
    renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('ab'));
  });
});

describe('searching on another page', () => {
  it('goes to the catalog (a new history entry)', async () => {
    nav.pathname = '/store/profile';
    renderApp(<Sync />);
    act(() => store().setText('steam'));
    await settle();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/store?q=steam', { scroll: false });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('in Russian the catalog address carries the prefix', async () => {
    nav.pathname = '/ru/store/profile';
    renderApp(<Sync />, { locale: 'ru' });
    act(() => store().setText('steam'));
    await settle();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/ru/store?q=steam', { scroll: false });
  });

  it('an empty search does nothing', async () => {
    nav.pathname = '/store/profile';
    renderApp(<Sync />);
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe('leaving the catalog', () => {
  it('with a search active neither pushes nor replaces anything, and "back" is free', async () => {
    nav.search = 'q=x';
    const { rerender } = renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();
    expect(nav.push).not.toHaveBeenCalled();

    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    await settle();
    expect(text()).toBe('x');
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();

    nav.pathname = '/store';
    nav.search = 'q=x';
    rerender(<Sync />);
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('BEFORE the search from the address has settled does not bounce back', async () => {
    // The race behind a flaky journey: open /store?q=x and go to the profile within 300 ms.
    nav.search = 'q=x';
    const { rerender } = renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a search typed on the profile afterwards still goes to the catalog', async () => {
    nav.search = 'q=x';
    const { rerender } = renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();
    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    act(() => store().setText('steam'));
    await settle();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/store?q=steam', { scroll: false });
  });
});

describe('address -> box, on the catalog', () => {
  it('the address changing by itself (back button) moves the box, without writing anything', async () => {
    nav.search = 'q=x';
    const { rerender } = renderApp(<Sync />);
    await waitFor(() => expect(text()).toBe('x'));
    await settle();

    nav.search = '';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe(''));
    nav.search = 'q=a';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe('a'));
    await settle();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('/store -> profile -> a search typed there -> back twice ends on an empty box at /store', async () => {
    nav.pathname = '/store/profile';
    const { rerender } = renderApp(<Sync />);
    act(() => store().setText('x'));
    await settle();
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/store?q=x', { scroll: false });

    nav.pathname = '/store';
    nav.search = 'q=x';
    rerender(<Sync />);
    await settle();
    expect(text()).toBe('x');

    nav.pathname = '/store/profile';
    nav.search = '';
    rerender(<Sync />);
    await settle();
    expect(text()).toBe('x');

    nav.pathname = '/store';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe(''));
    await settle();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a late arrival of one of our own earlier writes does not move the box, and the address is put right', async () => {
    const { rerender } = renderApp(<Sync />);
    // Typed and cleared before the first navigation has landed: the address never showed it.
    act(() => store().setText('ab'));
    await settle();
    expect(nav.replace).toHaveBeenLastCalledWith('/store?q=ab', { scroll: false });
    act(() => store().clear());
    await settle();

    nav.search = 'q=ab';
    rerender(<Sync />);
    await settle();
    expect(text()).toBe('');
    expect(nav.replace).toHaveBeenLastCalledWith('/store', { scroll: false });
  });

  it('a q that was never ours does move the box, even if it equals an old search', async () => {
    const { rerender } = renderApp(<Sync />);
    act(() => store().setText('ab'));
    await settle();
    nav.search = 'q=ab';
    rerender(<Sync />);
    act(() => store().clear());
    await waitFor(() => expect(nav.replace).toHaveBeenLastCalledWith('/store', { scroll: false }));
    nav.search = '';
    rerender(<Sync />);
    nav.search = 'q=ab';
    rerender(<Sync />);
    await waitFor(() => expect(text()).toBe('ab'));
  });
});
