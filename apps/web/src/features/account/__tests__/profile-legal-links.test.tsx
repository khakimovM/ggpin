import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../env';
import { MESSAGES } from '../../../i18n/messages';
import { createFakeWebApp, installWebApp } from '../../../telegram/__tests__/fake-webapp';
import { renderApp } from '../../auth/__tests__/test-utils';
import { ProfileLegalLinks } from '../ProfileLegalLinks';

const SITE = new URL(env.NEXT_PUBLIC_SITE_URL).origin;

afterEach(() => {
  delete window.Telegram;
  vi.restoreAllMocks();
});

describe.each([
  ['uz', ''],
  ['ru', '/ru'],
] as const)('the legal links of the Mini App profile (%s)', (locale, prefix) => {
  const t = MESSAGES[locale].account.profile.legal;

  it('Mini App: the full URL of the page, opened through Telegram on a tap', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    renderApp(<ProfileLegalLinks />, { locale });
    const terms = screen.getByRole('link', { name: t.terms });
    expect(terms).toHaveAttribute('href', `${SITE}${prefix}/terms`);
    expect(terms).toHaveAttribute('target', '_blank');
    expect(terms).toHaveAttribute('rel', 'noopener noreferrer');
    // fireEvent returns false when the handler took the tap over (preventDefault).
    expect(fireEvent.click(terms)).toBe(false);
    expect(app.openLink).toHaveBeenCalledExactlyOnceWith(`${SITE}${prefix}/terms`);
    fireEvent.click(screen.getByRole('link', { name: t.privacy }));
    expect(app.openLink).toHaveBeenLastCalledWith(`${SITE}${prefix}/privacy`);
  });

  it('Mini App: a client that refuses the call leaves the tap to the link itself', () => {
    const app = createFakeWebApp();
    vi.mocked(app.openLink).mockImplementation(() => {
      throw new Error('WebAppMethodUnsupported');
    });
    installWebApp(app);
    renderApp(<ProfileLegalLinks />, { locale });
    expect(fireEvent.click(screen.getByRole('link', { name: t.terms }))).toBe(true);
  });
});
