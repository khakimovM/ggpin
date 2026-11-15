import uz from '@repo/i18n/uz.json';
import { screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LoginStartPanel } from '../LoginStartPanel';
import { renderApp } from './test-utils';

// Owner decision (p8 S6): the sign-in button is not clickable before hydration, and says so.
describe('LoginStartPanel before and after hydration', () => {
  it('is disabled and aria-busy in the server markup', () => {
    const html = renderToString(
      <NextIntlClientProvider locale="uz" messages={uz}>
        <LoginStartPanel starting={false} problem={null} onStart={vi.fn()} />
      </NextIntlClientProvider>,
    );
    const button = /<button[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-busy="true"');
  });

  it('is enabled and not busy once hydrated', () => {
    renderApp(<LoginStartPanel starting={false} problem={null} onStart={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Telegram orqali kirish' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('keeps the loading state busy after hydration', () => {
    renderApp(<LoginStartPanel starting problem={null} onStart={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });
});
