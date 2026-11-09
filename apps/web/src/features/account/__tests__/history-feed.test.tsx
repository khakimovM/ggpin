import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { infiniteFeed, type Feed } from '../history-feed';
import { HistoryPager } from '../HistoryPager';
import { LoadMore } from '../LoadMore';

interface Row {
  id: string;
}
const page = (ids: string[], p: number) => ({
  items: ids.map((id) => ({ id })),
  meta: { page: p, limit: 3, total: 5 },
});
// Only the fields infiniteFeed reads.
function query(pages: ReturnType<typeof page>[]) {
  return {
    data: { pages, pageParams: pages.map((_, i) => i + 1) },
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: true,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  } as unknown as Parameters<typeof infiniteFeed<Row>>[0];
}

describe('infiniteFeed', () => {
  it('lists a row once when a write between two page loads pushed it onto the next page', () => {
    // "c" was the last row of page 1; a new row "n" arrived, so "c" is the first row of page 2 too.
    const feed = infiniteFeed(query([page(['a', 'b', 'c'], 1), page(['c', 'd', 'e'], 2)]));
    expect(feed.items.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps the first copy and the server order', () => {
    const feed = infiniteFeed(query([page(['b', 'a'], 1), page(['a', 'c'], 2)]));
    expect(feed.items.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });
});

function feedOf(overrides: Partial<Feed<unknown>> = {}): Feed<unknown> {
  return {
    status: 'ready',
    items: [],
    total: 0,
    page: 1,
    limit: 20,
    fetching: false,
    refetch: () => undefined,
    hasMore: true,
    loadMore: () => undefined,
    loadingMore: false,
    moreFailed: false,
    ...overrides,
  };
}

describe('LoadMore', () => {
  it('does not rebuild its observer on a plain re-render, and reads the latest callback', () => {
    const created = vi.fn();
    const observe = vi.fn();
    let fire: (intersecting: boolean) => void = () => undefined;
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        created();
        fire = (isIntersecting) =>
          callback([{ isIntersecting } as IntersectionObserverEntry], this as never);
      }
      observe = observe;
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    try {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderApp(<LoadMore feed={feedOf({ loadMore: first })} />);
      rerender(<LoadMore feed={feedOf({ loadMore: second })} />);
      rerender(<LoadMore feed={feedOf({ loadMore: second })} />);
      expect(created).toHaveBeenCalledTimes(1);
      fire(true);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('asks for nothing while the list refreshes in the background', () => {
    const created = vi.fn();
    class FakeObserver {
      constructor() {
        created();
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    try {
      renderApp(<LoadMore feed={feedOf({ fetching: true })} />);
      expect(created).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Yana yuklash' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a background refresh does not take the focus away from the button, and the press does nothing meanwhile', async () => {
    const loadMore = vi.fn();
    const { rerender } = renderApp(<LoadMore feed={feedOf({ loadMore })} />);
    const button = screen.getByRole('button', { name: 'Yana yuklash' });
    button.focus();
    rerender(<LoadMore feed={feedOf({ loadMore, fetching: true })} />);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(loadMore).not.toHaveBeenCalled();
    rerender(<LoadMore feed={feedOf({ loadMore })} />);
    expect(button).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(button);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('the button asks for the next page', async () => {
    const loadMore = vi.fn();
    renderApp(<LoadMore feed={feedOf({ loadMore })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Yana yuklash' }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});

describe('HistoryPager', () => {
  it('writes the totals with the digit grouping of the language', () => {
    renderApp(
      <HistoryPager
        feed={{
          page: 2,
          limit: 20,
          total: 12345,
          items: Array.from({ length: 20 }),
          fetching: false,
        }}
        onPage={() => undefined}
      />,
    );
    const summary = within(screen.getByRole('navigation', { name: 'Sahifalar' })).getByText(/Jami/);
    expect(summary).toHaveTextContent(/^Jami 12.345 tadan 21–40$/);
  });
});
