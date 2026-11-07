import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBackButton } from '../TelegramBackButton';
import { TelegramContext } from '../telegram-context';
import { useBackInterceptor } from '../use-back-button';
import { createFakeWebApp, type FakeWebApp } from './fake-webapp';

const nav = vi.hoisted(() => ({
  pathname: '/tg',
  back: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ back: nav.back, replace: nav.replace }),
}));

function Sheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useBackInterceptor(open, onClose);
  return null;
}

function mount(app: FakeWebApp, sheet?: { open: boolean; onClose: () => void }) {
  const tree = (current: typeof sheet) => (
    <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
      <TelegramBackButton />
      {current ? <Sheet {...current} /> : null}
    </TelegramContext.Provider>
  );
  const view = render(tree(sheet));
  return { ...view, update: (next: typeof sheet) => view.rerender(tree(next)) };
}

// A client-side navigation ends in history.pushState; going back fires popstate. (jsdom's own
// history.back() is asynchronous, so the event is dispatched by hand.)
const push = (path: string) => window.history.pushState({}, '', path);
const goBackInBrowser = () => act(() => void window.dispatchEvent(new PopStateEvent('popstate')));

beforeEach(() => {
  nav.pathname = '/tg';
  nav.back.mockClear();
  nav.replace.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TelegramBackButton', () => {
  it('is hidden on the home page and shown below it', () => {
    const home = createFakeWebApp();
    mount(home);
    expect(home.BackButton.show).not.toHaveBeenCalled();

    nav.pathname = '/tg/orders/42';
    const nested = createFakeWebApp();
    mount(nested);
    expect(nested.BackButton.show).toHaveBeenCalledOnce();
  });

  it('goes back when the app itself has pushed a screen on top of the one it came from', () => {
    nav.pathname = '/tg/orders';
    const app = createFakeWebApp();
    mount(app);
    push('/tg/orders/42');
    act(() => app.pressBack());
    expect(nav.back).toHaveBeenCalledOnce();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a screen opened directly returns to the home page instead of leaving the Mini App', () => {
    nav.pathname = '/tg/orders';
    const app = createFakeWebApp();
    mount(app);
    act(() => app.pressBack());
    expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/tg');
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('deep link /tg/a, push /tg/b, back to /tg/a: nothing to go back to, so it goes home', () => {
    // history.length is 2 here, which is the signal that used to make the button dead.
    nav.pathname = '/tg/a';
    const app = createFakeWebApp();
    mount(app);
    push('/tg/b');
    expect(window.history.length).toBeGreaterThan(1);
    goBackInBrowser();
    act(() => app.pressBack());
    expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/tg');
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('two screens pushed and one gone back over: one is left, so it goes back', () => {
    nav.pathname = '/tg/a';
    const app = createFakeWebApp();
    mount(app);
    push('/tg/b');
    push('/tg/c');
    goBackInBrowser();
    act(() => app.pressBack());
    expect(nav.back).toHaveBeenCalledOnce();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a replaced entry is not a screen to go back to', () => {
    nav.pathname = '/tg/a';
    const app = createFakeWebApp();
    mount(app);
    window.history.replaceState({}, '', '/tg/b');
    act(() => app.pressBack());
    expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/tg');
  });

  it('stops counting, and unhooks history.pushState, when the button goes away', () => {
    const original: unknown = Reflect.get(window.history, 'pushState');
    nav.pathname = '/tg/a';
    const app = createFakeWebApp();
    const view = mount(app);
    expect(Reflect.get(window.history, 'pushState')).not.toBe(original);
    view.unmount();
    expect(Reflect.get(window.history, 'pushState')).toBe(original);
  });

  it('an open sheet on the home page shows the button, and the button closes the sheet', () => {
    const app = createFakeWebApp();
    const close = vi.fn();
    const { update } = mount(app, { open: false, onClose: close });
    expect(app.BackButton.show).not.toHaveBeenCalled();

    update({ open: true, onClose: close });
    expect(app.BackButton.show).toHaveBeenCalledOnce();
    act(() => app.pressBack());
    expect(close).toHaveBeenCalledOnce();
    expect(nav.back).not.toHaveBeenCalled();

    update({ open: false, onClose: close });
    expect(app.BackButton.hide).toHaveBeenCalledOnce();
  });

  it('an inline close callback does not reorder or duplicate nested sheets', () => {
    const app = createFakeWebApp();
    const outer = vi.fn<() => void>();
    const inner = vi.fn<() => void>();
    const tree = (outerFn: () => void, innerFn: () => void) => (
      <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
        <TelegramBackButton />
        <Sheet open onClose={outerFn} />
        <Sheet open onClose={innerFn} />
      </TelegramContext.Provider>
    );
    const view = render(tree(outer, inner));
    // Only the OUTER sheet's parent re-renders, with a new inline callback, again and again: it
    // must not be pushed back above the inner sheet.
    view.rerender(tree(() => outer(), inner));
    view.rerender(tree(() => outer(), inner));
    act(() => app.pressBack());
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    // Closing the inner one leaves exactly the outer one.
    view.rerender(
      <TelegramContext.Provider value={{ phase: 'telegram', webApp: app }}>
        <TelegramBackButton />
        <Sheet open onClose={() => outer()} />
        <Sheet open={false} onClose={() => inner()} />
      </TelegramContext.Provider>,
    );
    act(() => app.pressBack());
    expect(outer).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
  });
});
