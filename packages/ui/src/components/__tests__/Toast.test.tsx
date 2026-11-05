import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '../../lib/toast-context';
import { Toast } from '../Toast';
import { ToastProvider } from '../ToastProvider';

function Trigger({ tone }: { tone?: 'success' | 'error' }) {
  const toast = useToast();
  return (
    <button
      onClick={() => toast.show({ tone, title: 'Yetkazildi', description: '500 ⭐ yuborildi' })}
    >
      Ko‘rsatish
    </button>
  );
}

describe('Toast', () => {
  it('has no live role of its own: the provider region announces it, once', () => {
    render(<Toast tone="error" title="To‘lov o‘tmadi" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('To‘lov o‘tmadi')).toBeInTheDocument();
  });

  it('shows a close button only when it can be closed', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast title="Salom" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<Toast title="Salom" onClose={onClose} closeLabel="Yopish" />);
    await userEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a close handler without an accessible name does not compile', () => {
    const never = () => {
      // @ts-expect-error onClose needs closeLabel: an icon-only button must have a name
      return <Toast title="x" onClose={() => undefined} />;
    };
    expect(never).toBeTypeOf('function');
  });
});

// React derives onPointerEnter / onPointerLeave from pointerover / pointerout; jsdom has no
// PointerEvent, so the pointerType is attached by hand.
function pointer(target: HTMLElement, type: 'pointerover' | 'pointerout', pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: null });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
}

function mounted(tone?: 'success' | 'error') {
  return render(
    <ToastProvider closeLabel="Yopish">
      <Trigger tone={tone} />
    </ToastProvider>,
  );
}

describe('ToastProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast from useToast and removes it when closed', async () => {
    mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    expect(await screen.findByText('500 ⭐ yuborildi')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    await waitFor(() => expect(screen.queryByText('500 ⭐ yuborildi')).not.toBeInTheDocument());
  });

  it('announces through exactly one live region: polite, or assertive for errors', async () => {
    const { container } = mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    const toast = await screen.findByText('500 ⭐ yuborildi');
    expect(toast.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    // no nested role=alert / role=status inside the live region
    expect(
      container.ownerDocument.querySelectorAll('[role="alert"], [role="status"]'),
    ).toHaveLength(0);
  });

  it('errors go to the assertive region', async () => {
    mounted('error');
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    const toast = await screen.findByText('500 ⭐ yuborildi');
    expect(toast.closest('[aria-live]')).toHaveAttribute('aria-live', 'assertive');
  });

  it('closes itself after 4 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    expect(await screen.findByText('500 ⭐ yuborildi')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    await waitFor(() => expect(screen.queryByText('500 ⭐ yuborildi')).not.toBeInTheDocument());
  });

  it('keeps an error on screen longer than 4 seconds, and closes it by 8', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted('error');
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    expect(await screen.findByText('500 ⭐ yuborildi')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('500 ⭐ yuborildi')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    await waitFor(() => expect(screen.queryByText('500 ⭐ yuborildi')).not.toBeInTheDocument());
  });

  it('hovering pauses the clock and leaving resumes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    const text = await screen.findByText('500 ⭐ yuborildi');
    const card = text.closest('.pointer-events-auto') as HTMLElement;
    pointer(card, 'pointerover', 'mouse');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('500 ⭐ yuborildi')).toBeInTheDocument();
    pointer(card, 'pointerout', 'mouse');
    act(() => {
      vi.advanceTimersByTime(4200);
    });
    await waitFor(() => expect(screen.queryByText('500 ⭐ yuborildi')).not.toBeInTheDocument());
  });

  it('a touch "hover" does not pause the clock (it would never be released)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    const card = (await screen.findByText('500 ⭐ yuborildi')).closest(
      '.pointer-events-auto',
    ) as HTMLElement;
    pointer(card, 'pointerover', 'touch');
    act(() => {
      vi.advanceTimersByTime(4200);
    });
    await waitFor(() => expect(screen.queryByText('500 ⭐ yuborildi')).not.toBeInTheDocument());
  });

  it('toasts pushed out by newer ones stop their timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted();
    for (let count = 0; count < 5; count += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    }
    await waitFor(() => expect(screen.getAllByText('Yetkazildi')).toHaveLength(3));
    // one live countdown per visible toast, none left for the two that were pushed out
    expect(vi.getTimerCount()).toBe(3);
    act(() => {
      vi.advanceTimersByTime(4200);
    });
    await waitFor(() => expect(screen.queryByText('Yetkazildi')).not.toBeInTheDocument());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keyboard focus inside a toast pauses it too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mounted();
    await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    await screen.findByText('500 ⭐ yuborildi');
    act(() => {
      screen.getByRole('button', { name: 'Yopish' }).focus();
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('500 ⭐ yuborildi')).toBeInTheDocument();
  });

  it('keeps at most three toasts on screen', async () => {
    mounted();
    for (let count = 0; count < 5; count += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Ko‘rsatish' }));
    }
    await waitFor(() => expect(screen.getAllByText('Yetkazildi')).toHaveLength(3));
  });

  it('throws a clear error when useToast is used without the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow('useToast must be used inside <ToastProvider>');
    spy.mockRestore();
  });
});
