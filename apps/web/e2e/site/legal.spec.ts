import { expect, test } from '@playwright/test';
import { BRAND } from '@repo/shared';
import { tgCalls } from '../fixtures/telegram';
import { openStoreAccount } from '../store/account-support';
import { openStore } from '../store/catalog-support';
import { openAccount } from '../tg/account-support';
import { overflow } from '../tg/support';
import { INFO_LANGS, infoPath, LEGAL_PAGES, openInfo, SITE, type InfoLang } from './info-support';
import { seriousViolations } from './shell-support';

// The legal pages of phase 8 S4: drafts until the lawyer's text (D-16, D-57), so each says only
// that the document is being prepared, links to the contacts and carries noindex. And the ways to
// them: the site footer, the store footer (the web profile has no links of its own, as in
// Store.dc.html) and the Mini App profile (which opens them outside itself through
// Telegram.WebApp.openLink). The protocol checks (raw HTML, the sitemap) are in info.http.spec.ts.

for (const lang of ['uz', 'ru'] as const satisfies InfoLang[]) {
  const { copy, prefix } = INFO_LANGS[lang];

  test.describe(`${lang}: a legal page while it is a draft`, () => {
    for (const doc of LEGAL_PAGES) {
      test(`${doc}: the title, "being prepared", one link to the contacts, and noindex`, async ({
        page,
      }) => {
        await openInfo(page, doc, lang);
        const main = page.getByRole('main');
        const title = copy.site.meta[doc].title;
        await expect(main.getByRole('heading', { level: 1 })).toHaveText(title);
        await expect(main.getByText(copy.legal.draftNotice)).toBeVisible();
        // Nothing more: no table of contents, no section, no legal wording.
        await expect(main.getByRole('heading')).toHaveCount(1);
        await expect(main.getByRole('link')).toHaveCount(1);
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          'content',
          'noindex, follow',
        );
        await expect(page).toHaveTitle(`${title} — ${BRAND.name}`);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          'href',
          `${SITE}${infoPath(doc, lang)}`,
        );
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        await main.getByRole('link', { name: copy.legal.contact }).click();
        await expect(page).toHaveURL(`${SITE}${prefix}/contacts`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          copy.site.meta.contacts.title,
        );
      });
    }

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: axe finds nothing serious on a draft`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openInfo(page, 'privacy', lang);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });

  test.describe(`${lang}: the ways to the legal pages`, () => {
    test('the site footer lists the four information pages, and each of them answers', async ({
      page,
      request,
    }) => {
      await page.goto(prefix === '' ? '/' : prefix);
      const footer = page.getByRole('contentinfo');
      const label = copy.site.footer.infoLinks;
      for (const key of ['faq', 'terms', 'privacy', 'contacts'] as const) {
        const link = footer.getByRole('link', { name: label[key] });
        await expect(link).toHaveAttribute('href', `${prefix}/${key}`);
        expect((await request.get(`${prefix}/${key}`)).status(), key).toBe(200);
      }
    });

    test('the store footer: the offer, the privacy policy and the contacts', async ({ page }) => {
      await openStore(page, { lang });
      const footer = page.getByRole('contentinfo');
      const t = copy.web.footer;
      await expect(footer.getByRole('link', { name: t.terms })).toHaveAttribute(
        'href',
        `${prefix}/terms`,
      );
      await expect(footer.getByRole('link', { name: t.contact })).toHaveAttribute(
        'href',
        `${prefix}/contacts`,
      );
      await footer.getByRole('link', { name: t.privacy }).click();
      await expect(page).toHaveURL(`${SITE}${prefix}/privacy`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        copy.site.meta.privacy.title,
      );
    });

    test('the web profile: no legal links of its own (Store.dc.html), the store footer has them', async ({
      page,
    }) => {
      await openStoreAccount(page, '/store/profile', { lang });
      const main = page.getByRole('main');
      await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
      const legal = copy.account.profile.legal;
      await expect(main.getByRole('link', { name: legal.terms })).toHaveCount(0);
      await expect(main.getByRole('link', { name: legal.privacy })).toHaveCount(0);
      const footer = page.getByRole('contentinfo');
      await expect(footer.getByRole('link', { name: copy.web.footer.terms })).toHaveAttribute(
        'href',
        `${prefix}/terms`,
      );
      await expect(footer.getByRole('link', { name: copy.web.footer.privacy })).toHaveAttribute(
        'href',
        `${prefix}/privacy`,
      );
    });

    test('the Mini App profile: a tap opens the page outside, through Telegram.WebApp.openLink', async ({
      page,
    }) => {
      await openAccount(page, '/tg/profile', { lang });
      const t = copy.account.profile.legal;
      const terms = page.getByRole('link', { name: t.terms });
      await expect(terms).toHaveAttribute('href', `${SITE}${prefix}/terms`);
      await terms.click();
      await page.getByRole('link', { name: t.privacy }).click();
      const opened = (await tgCalls(page)).filter(([name]) => name === 'openLink');
      expect(opened).toEqual([
        ['openLink', `${SITE}${prefix}/terms`],
        ['openLink', `${SITE}${prefix}/privacy`],
      ]);
      // The Mini App stays where it was: nothing was loaded inside it.
      await expect(page).toHaveURL(`${SITE}/tg/profile`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(copy.account.profile.title);
    });
  });
}

test('Mini App: a client that refuses openLink leaves the tap to the link, which opens a new tab', async ({
  page,
}) => {
  await openAccount(page, '/tg/profile', { openLinkRefusals: 1 });
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: INFO_LANGS.uz.copy.account.profile.legal.terms }).click();
  await expect(await popup).toHaveURL(`${SITE}/terms`);
  // The client was asked first (and said no); the Mini App itself stayed where it was.
  const opened = (await tgCalls(page)).filter(([name]) => name === 'openLink');
  expect(opened).toEqual([['openLink', `${SITE}/terms`]]);
  await expect(page).toHaveURL(`${SITE}/tg/profile`);
});
