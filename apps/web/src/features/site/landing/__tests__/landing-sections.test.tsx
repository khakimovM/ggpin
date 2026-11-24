import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import type { SiteLinks } from '../../shell/site-links';
import { FaqSection } from '../FaqSection';
import { FinalCta } from '../FinalCta';
import { Hero } from '../Hero';
import { HowItWorks } from '../HowItWorks';
import { WhyUs } from '../WhyUs';
import { settleServerTree } from './render-server';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);

// The links come from configuration; each test sets what the configuration says.
const links = vi.hoisted((): { value: SiteLinks } => ({
  value: {
    bot: 'https://t.me/test_bot',
    botHandle: '@test_bot',
    channel: null,
    support: 'https://t.me/test_support',
  },
}));
vi.mock('../../shell/site-links', () => ({ siteLinks: () => links.value }));

const COPY = {
  uz: MESSAGES.uz.site,
  ru: MESSAGES.ru.site,
} as const;

beforeEach(() => {
  links.value = {
    bot: 'https://t.me/test_bot',
    botHandle: '@test_bot',
    channel: null,
    support: 'https://t.me/test_support',
  };
});

describe.each(['uz', 'ru'] as const)('the landing sections (%s)', (locale) => {
  const copy = COPY[locale];
  const store = locale === 'uz' ? '/store' : '/ru/store';

  it('hero: the H1, the two buttons, the three promises and a decorative picture', async () => {
    const { container } = render(await settleServerTree(await Hero({ locale })));
    // The title keeps a no-break space before its dash (a line must not start with it); the
    // matcher folds the page's spaces, so the expected text is folded the same way.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      `${copy.hero.title} ${copy.hero.titleAccent}`.replace(/\s+/g, ' '),
    );
    expect(copy.hero.title).toContain(String.fromCharCode(0xa0, 0x2014));
    const bot = screen.getByRole('link', { name: copy.cta.telegram });
    expect(bot).toHaveAttribute('href', 'https://t.me/test_bot');
    expect(bot).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: copy.cta.store })).toHaveAttribute('href', store);
    for (const text of Object.values(copy.hero.trust)) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    // The picture (phone and cards) is hidden from assistive technology as a whole.
    const picture = container.querySelector('section > div > div[aria-hidden="true"]');
    expect(picture).not.toBeNull();
    expect(within(picture as HTMLElement).getByText(copy.hero.mock.delivered)).toBeInTheDocument();
  });

  it('hero: the user in the picture is a template, never a real person, and no price floats', async () => {
    const { container } = render(await settleServerTree(await Hero({ locale })));
    const text = container.textContent ?? '';
    expect(text).toContain('@username');
    expect(text).not.toMatch(/dilnoza|sardor|660 UC|120.750/i);
    // The only amount in the hero is the phone's sample balance; the floating cards have none.
    const floating = container.querySelectorAll('[class*="gg-float-in"]');
    expect(floating).toHaveLength(2);
    for (const card of floating) expect(card.textContent).not.toMatch(/\d\s*(so‘m|сум)/);
  });

  it('hero: without a bot configured the Telegram button is left out, the store button stays', async () => {
    links.value = { ...links.value, bot: null, botHandle: null };
    render(await settleServerTree(await Hero({ locale })));
    expect(screen.queryByRole('link', { name: copy.cta.telegram })).toBeNull();
    expect(screen.getByRole('link', { name: copy.cta.store })).toHaveAttribute('href', store);
  });

  it('final call: the same two ways in, the bot one only when configured', async () => {
    const first = render(await settleServerTree(await FinalCta({ locale })));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(copy.cta.title);
    expect(screen.getByRole('link', { name: copy.cta.telegram })).toHaveAttribute(
      'href',
      'https://t.me/test_bot',
    );
    first.unmount();
    links.value = { ...links.value, bot: null };
    render(await settleServerTree(await FinalCta({ locale })));
    expect(screen.queryByRole('link', { name: copy.cta.telegram })).toBeNull();
    expect(screen.getByRole('link', { name: copy.cta.store })).toHaveAttribute('href', store);
  });

  it('FAQ: five questions, the first answer open, and the support button when configured', async () => {
    const { container } = render(await settleServerTree(await FaqSection({ locale })));
    expect(container.querySelectorAll('details')).toHaveLength(5);
    expect([...container.querySelectorAll('details')].map((item) => item.open)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(container.querySelector('section')).toHaveAttribute('id', 'faq');
    const support = screen.getByRole('link', { name: copy.faq.support });
    expect(support).toHaveAttribute('href', 'https://t.me/test_support');
    expect(support).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('FAQ: with no support link configured the button is left out', async () => {
    links.value = { ...links.value, support: null };
    render(await settleServerTree(await FaqSection({ locale })));
    expect(screen.queryByRole('link', { name: copy.faq.support })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(5);
  });

  it('how it works: three numbered steps, Humo and Uzcard, and the id the header points at', async () => {
    const { container } = render(await settleServerTree(await HowItWorks({ locale })));
    expect(container.querySelector('section')).toHaveAttribute('id', 'how-it-works');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      copy.how.steps.s1,
      copy.how.steps.s2,
      copy.how.steps.s3,
    ]);
    expect(screen.getAllByText('Humo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Uzcard').length).toBeGreaterThan(0);
    // The old Russian hero named other providers; the payment text is Humo and Uzcard only.
    expect(container.textContent).not.toMatch(/Click|Payme|Uzum|Rahmat/);
  });

  it('why us: the four reasons, each with a heading and a sentence', async () => {
    render(await settleServerTree(await WhyUs({ locale })));
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(screen.getByText(copy.why.items.refund.text)).toBeInTheDocument();
  });
});

describe('the landing texts', () => {
  it('make no promise the product page does not (the referral band is not among them)', () => {
    for (const locale of ['uz', 'ru'] as const) {
      expect(JSON.stringify(COPY[locale])).not.toMatch(/referral|1\s?%/i);
    }
  });

  it('keep Uzbek apostrophes typographic in the landing blocks', () => {
    const text = JSON.stringify(COPY.uz);
    expect(text).not.toContain('’');
    expect(text).not.toContain("'");
  });
});
