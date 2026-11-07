import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMainButton, type MainButtonOptions } from '../use-main-button';
import { createFakeWebApp, type FakeWebApp } from './fake-webapp';

const done = () => Promise.resolve();

function Screen({
  app,
  onClick = done,
  onError,
  enabled = true,
  loading = false,
  visible = true,
  text = 'Sotib olish',
}: { app: FakeWebApp | null; text?: string } & Partial<MainButtonOptions>) {
  useMainButton(app, { text, onClick, onError, enabled, loading, visible });
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMainButton', () => {
  it('shows the button with its text, enabled and without progress', () => {
    const app = createFakeWebApp();
    render(<Screen app={app} />);
    expect(app.MainButton.setText).toHaveBeenLastCalledWith('Sotib olish');
    expect(app.MainButton.enable).toHaveBeenCalled();
    expect(app.MainButton.hideProgress).toHaveBeenCalled();
    expect(app.MainButton.show).toHaveBeenCalled();
  });

  it('one handler for the whole life of the screen, however often it re-renders', () => {
    const app = createFakeWebApp();
    const { rerender } = render(<Screen app={app} />);
    rerender(<Screen app={app} text="To‘lash" onClick={() => done()} />);
    rerender(<Screen app={app} text="To‘lash" onClick={() => done()} />);
    expect(app.MainButton.onClick).toHaveBeenCalledOnce();
    expect(app.MainButton.setText).toHaveBeenLastCalledWith('To‘lash');
  });

  it('calls the latest onClick', () => {
    const app = createFakeWebApp();
    const first = vi.fn(done);
    const second = vi.fn(done);
    const { rerender } = render(<Screen app={app} onClick={first} />);
    rerender(<Screen app={app} onClick={second} />);
    act(() => app.pressMain());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('two presses in the same act, with no render between them, run the action once', async () => {
    const app = createFakeWebApp();
    let finish: () => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Screen app={app} onClick={action} />);
    act(() => {
      app.pressMain();
      app.pressMain();
      app.pressMain();
    });
    expect(action).toHaveBeenCalledOnce();
    // Still pending, and a later press (after a render) is ignored too.
    act(() => app.pressMain());
    expect(action).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    act(() => app.pressMain());
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('a rejection frees the button again, and goes to onError', async () => {
    const app = createFakeWebApp();
    const failure = new Error('declined');
    const onError = vi.fn();
    const action = vi.fn(() => Promise.reject(failure));
    render(<Screen app={app} onClick={action} onError={onError} />);
    await act(async () => {
      app.pressMain();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    act(() => app.pressMain());
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('without onError a rejection is reported as a window error, never swallowed', async () => {
    const app = createFakeWebApp();
    const failure = new Error('declined');
    const reports: unknown[] = [];
    vi.stubGlobal('reportError', (error: unknown) => reports.push(error));
    render(<Screen app={app} onClick={() => Promise.reject(failure)} />);
    await act(async () => {
      app.pressMain();
      await Promise.resolve();
    });
    vi.unstubAllGlobals();
    expect(reports).toEqual([failure]);
  });

  it('a rejection is not an unhandled promise rejection', async () => {
    const app = createFakeWebApp();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.stubGlobal('reportError', () => undefined);
    render(<Screen app={app} onClick={() => Promise.reject(new Error('declined'))} />);
    await act(async () => {
      app.pressMain();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    vi.unstubAllGlobals();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('an action that throws before it returns a promise is treated like a rejection', async () => {
    const app = createFakeWebApp();
    const onError = vi.fn();
    const action = vi.fn((): Promise<unknown> => {
      throw new Error('boom');
    });
    render(<Screen app={app} onClick={action} onError={onError} />);
    await act(async () => {
      app.pressMain();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledOnce();
    act(() => app.pressMain());
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('ignores presses while progress is showing', () => {
    const app = createFakeWebApp();
    const action = vi.fn(done);
    const { rerender } = render(<Screen app={app} onClick={action} />);
    rerender(<Screen app={app} onClick={action} loading />);
    expect(app.MainButton.showProgress).toHaveBeenLastCalledWith(false);
    act(() => app.pressMain());
    expect(action).not.toHaveBeenCalled();
    rerender(<Screen app={app} onClick={action} loading={false} />);
    act(() => app.pressMain());
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses the loading flag of the latest render before the next press', () => {
    const app = createFakeWebApp();
    const action = vi.fn(done);
    function Flow() {
      const [busy, setBusy] = useState(false);
      useMainButton(app, {
        text: 'Pay',
        loading: busy,
        onClick: () => {
          setBusy(true);
          return new Promise(() => undefined);
        },
      });
      return null;
    }
    render(<Flow />);
    act(() => app.pressMain());
    act(() => app.pressMain());
    expect(action).not.toHaveBeenCalled();
    expect(app.MainButton.showProgress).toHaveBeenCalledWith(false);
  });

  it('ignores presses while disabled', () => {
    const app = createFakeWebApp();
    const action = vi.fn(done);
    render(<Screen app={app} onClick={action} enabled={false} />);
    expect(app.MainButton.disable).toHaveBeenCalled();
    act(() => app.pressMain());
    expect(action).not.toHaveBeenCalled();
  });

  it('hides the button, its progress and its handler when the screen goes away', () => {
    const app = createFakeWebApp();
    const { unmount } = render(<Screen app={app} />);
    unmount();
    expect(app.MainButton.offClick).toHaveBeenCalledOnce();
    expect(app.MainButton.hide).toHaveBeenCalled();
    expect(app.MainButton.hideProgress).toHaveBeenCalled();
  });

  it('does nothing outside Telegram', () => {
    expect(() => render(<Screen app={null} onClick={vi.fn(done)} />)).not.toThrow();
  });
});
