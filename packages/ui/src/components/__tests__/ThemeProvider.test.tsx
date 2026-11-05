import { act, render, screen } from '@testing-library/react';
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

  it('useTheme outside the provider fails loudly', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow('useTheme must be used inside <ThemeProvider>');
    spy.mockRestore();
  });
});
