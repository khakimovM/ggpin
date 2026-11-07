import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockMatchMedia } from '../../../test/match-media';
import { useTheme } from '../../lib/theme-context';
import { ThemeProvider } from '../ThemeProvider';

function Probe() {
  const { theme, preference, setPreference, reducedMotion, setReducedMotion } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="preference">{preference}</span>
      <span data-testid="reduced">{String(reducedMotion)}</span>
      <button onClick={() => setPreference('dark')}>dark</button>
      <button onClick={() => setReducedMotion(true)}>reduce</button>
    </div>
  );
}

function mockSystemScheme(dark: boolean) {
  mockMatchMedia((query) => dark && query.includes('prefers-color-scheme: dark'));
}

describe('ThemeProvider', () => {
  it('telegram: data-theme follows the Telegram colour scheme and cannot be toggled', async () => {
    const { rerender } = render(
      <ThemeProvider variant="telegram" colorScheme="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    rerender(
      <ThemeProvider variant="telegram" colorScheme="light">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('ggpin-theme')).toBeNull();
  });

  it('web: follows the system scheme until the user picks one', () => {
    mockSystemScheme(true);
    render(
      <ThemeProvider variant="web">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByTestId('preference')).toHaveTextContent('system');
  });

  it('web: a stored preference beats the system scheme', () => {
    mockSystemScheme(true);
    window.localStorage.setItem('ggpin-theme', 'light');
    render(
      <ThemeProvider variant="web">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('web: choosing dark sets data-theme and persists the choice', async () => {
    render(
      <ThemeProvider variant="web">
        <Probe />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('ggpin-theme')).toBe('dark');
  });

  it('reduced motion: sets data-reduced (the attribute tokens.css listens to) and removes it again', async () => {
    const { rerender } = render(
      <ThemeProvider variant="web">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement).not.toHaveAttribute('data-reduced');
    await userEvent.click(screen.getByRole('button', { name: 'reduce' }));
    expect(document.documentElement.dataset.reduced).toBe('true');
    expect(screen.getByTestId('reduced')).toHaveTextContent('true');

    window.localStorage.clear();
    rerender(
      <ThemeProvider variant="web" reducedMotion={false}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => Promise.resolve());
    expect(document.documentElement).not.toHaveAttribute('data-reduced');
  });

  it('a controlled reducedMotion prop wins and reports changes', async () => {
    const onChange = vi.fn();
    render(
      <ThemeProvider variant="telegram" reducedMotion onReducedMotionChange={onChange}>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset.reduced).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'reduce' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('hydration: never writes the server-snapshot theme over the one the page script set', () => {
    // The page's pre-paint script has set dark (stored). The server render knows nothing of that
    // (no storage, light OS), so a write from that pass would flash light before dark returns.
    mockSystemScheme(false);
    window.localStorage.setItem('ggpin-theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
    const tree = (
      <ThemeProvider variant="web">
        <Probe />
      </ThemeProvider>
    );
    const container = document.createElement('div');
    document.body.append(container);
    container.innerHTML = renderToString(tree);

    // The records of every write, with the value it replaced (oldValue), so a write that is undone
    // within the same task is still seen.
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
      attributeOldValue: true,
    });
    let root: ReturnType<typeof hydrateRoot> | undefined;
    act(() => {
      root = hydrateRoot(container, tree);
    });
    const written = observer.takeRecords().map((record) => record.oldValue);
    observer.disconnect();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(written).not.toContain('light');
    act(() => root?.unmount());
    container.remove();
  });

  it('useTheme outside the provider fails loudly', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow('useTheme must be used inside <ThemeProvider>');
    spy.mockRestore();
  });
});
