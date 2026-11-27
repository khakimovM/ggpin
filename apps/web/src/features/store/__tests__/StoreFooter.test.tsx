import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../i18n/messages';
import { renderApp } from '../../auth/__tests__/test-utils';
import { StoreFooter } from '../StoreFooter';

afterEach(() => {
  vi.useRealTimers();
});

describe('StoreFooter', () => {
  it('the year is the one in Uzbekistan: 20:00 UTC on 31 December is already the new year there', () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T20:00:00Z'), toFake: ['Date'] });
    renderApp(<StoreFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/© 2026 /);
  });

  it('and the old year while it is still the old year there', () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T18:59:00Z'), toFake: ['Date'] });
    renderApp(<StoreFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/© 2025 /);
  });

  it.each([
    ['uz', ''],
    ['ru', '/ru'],
  ] as const)(
    '%s: the offer, the privacy policy and the contacts are pages of the site, in this language',
    (locale, prefix) => {
      renderApp(<StoreFooter />, { locale });
      const t = MESSAGES[locale].web.footer;
      const footer = within(screen.getByRole('contentinfo'));
      const hrefs = footer
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]);
      expect(hrefs).toEqual([
        [t.terms, `${prefix}/terms`],
        [t.privacy, `${prefix}/privacy`],
        [t.contact, `${prefix}/contacts`],
      ]);
      // Pages of the site open in the same tab; nothing here leaves the site.
      for (const link of footer.getAllByRole('link')) expect(link).not.toHaveAttribute('target');
    },
  );
});
