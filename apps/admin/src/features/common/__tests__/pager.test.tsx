import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAdmin } from '../../../test/render';
import { Pager } from '../Pager';
import { SearchField } from '../SearchField';
import { lastPage } from '../pager-model';

afterEach(() => {
  vi.useRealTimers();
});

describe('list pager (R-8)', () => {
  it('knows the last page', () => {
    expect(lastPage({ total: 0, limit: 20 })).toBe(1);
    expect(lastPage({ total: 20, limit: 20 })).toBe(1);
    expect(lastPage({ total: 21, limit: 20 })).toBe(2);
  });

  it('renders nothing for an empty list', () => {
    const onPage = vi.fn();
    const { container } = renderAdmin(
      <Pager meta={{ page: 1, limit: 20, total: 0 }} onPage={onPage} />,
    );
    expect(container.textContent).toBe('');
    expect(onPage).not.toHaveBeenCalled();
  });

  it('moves a page past the end to the last page, replacing the history entry', () => {
    const onPage = vi.fn();
    renderAdmin(<Pager meta={{ page: 9, limit: 20, total: 45 }} onPage={onPage} />);
    expect(onPage).toHaveBeenCalledWith(3, { replace: true });
    expect(screen.queryByText(/Jami/)).toBeNull();
  });

  it('shows the range of a normal page', () => {
    renderAdmin(<Pager meta={{ page: 2, limit: 20, total: 45 }} onPage={vi.fn()} />);
    expect(screen.getByText('Jami 45 tadan 21–40')).toBeInTheDocument();
  });
});

describe('search box (R-15)', () => {
  it('keeps a trailing space while the admin types on after the debounced write', () => {
    vi.useFakeTimers();
    let value = '';
    const onChange = vi.fn((next: string) => {
      value = next;
    });
    // Plain render: rerender must keep the same tree (no provider wrapper) so state survives.
    const { rerender } = render(
      <SearchField label="Qidirish" placeholder="" value={value} onChange={onChange} />,
    );
    const box = screen.getByRole('searchbox', { name: 'Qidirish' });
    fireEvent.change(box, { target: { value: 'ali ' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenCalledWith('ali');
    // The URL echoes the trimmed value back.
    rerender(<SearchField label="Qidirish" placeholder="" value={value} onChange={onChange} />);
    expect(box).toHaveValue('ali ');
    // A change from outside (a cleared filter) still replaces the draft.
    rerender(<SearchField label="Qidirish" placeholder="" value="" onChange={onChange} />);
    expect(box).toHaveValue('');
  });
});
