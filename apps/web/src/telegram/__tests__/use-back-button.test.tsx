import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { runBackHandler } from '../back-stack';
import { useBackButton, useBackInterceptor } from '../use-back-button';
import { createFakeWebApp, type FakeWebApp } from './fake-webapp';

function Screen({
  app,
  visible,
  onBack,
  overlay,
}: {
  app: FakeWebApp;
  visible: boolean;
  onBack: () => void;
  overlay?: () => void;
}) {
  useBackButton(app, visible, onBack);
  useBackInterceptor(overlay !== undefined, overlay ?? (() => undefined));
  return null;
}

describe('BackButton', () => {
  it('is shown only while the screen is nested, and hidden again after', () => {
    const app = createFakeWebApp();
    const { rerender } = render(<Screen app={app} visible={false} onBack={vi.fn()} />);
    expect(app.BackButton.show).not.toHaveBeenCalled();
    rerender(<Screen app={app} visible onBack={vi.fn()} />);
    expect(app.BackButton.show).toHaveBeenCalledOnce();
    rerender(<Screen app={app} visible={false} onBack={vi.fn()} />);
    expect(app.BackButton.hide).toHaveBeenCalledOnce();
    expect(app.BackButton.offClick).toHaveBeenCalledOnce();
  });

  it('goes back when pressed', () => {
    const app = createFakeWebApp();
    const onBack = vi.fn();
    render(<Screen app={app} visible onBack={onBack} />);
    act(() => app.pressBack());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('closes an open sheet first, and goes back only on the next press', () => {
    const app = createFakeWebApp();
    const onBack = vi.fn();
    const closeSheet = vi.fn();
    const { rerender } = render(<Screen app={app} visible onBack={onBack} overlay={closeSheet} />);
    act(() => app.pressBack());
    expect(closeSheet).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
    // The sheet reports itself closed: the interceptor is gone.
    rerender(<Screen app={app} visible onBack={onBack} />);
    act(() => app.pressBack());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('the topmost overlay is handled first', () => {
    const app = createFakeWebApp();
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Screen app={app} visible onBack={vi.fn()} overlay={outer} />
        <Screen app={app} visible onBack={vi.fn()} overlay={inner} />
      </>,
    );
    expect(runBackHandler()).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });
});
