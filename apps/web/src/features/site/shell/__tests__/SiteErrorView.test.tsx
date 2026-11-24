import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { SiteErrorView } from '../SiteErrorView';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function renderView(locale: 'uz' | 'ru', reset = vi.fn(), fullPage = true) {
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ common: MESSAGES[locale].common, site: { error: MESSAGES[locale].site.error } }}
    >
      <SiteErrorView reset={reset} fullPage={fullPage} />
    </NextIntlClientProvider>,
  );
  return reset;
}

describe('SiteErrorView', () => {
  it.each(['uz', 'ru'] as const)('says what happened, in %s, as an alert', (locale) => {
    renderView(locale);
    const copy = MESSAGES[locale].site.error;
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
  });

  it('the button asks the server again and retries the render', async () => {
    const reset = renderView('uz');
    await userEvent.click(screen.getByRole('button', { name: 'Sahifani yangilash' }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
