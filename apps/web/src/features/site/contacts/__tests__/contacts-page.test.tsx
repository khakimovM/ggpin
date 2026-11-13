import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { settleServerTree } from '../../landing/__tests__/render-server';
import type { SiteLinks } from '../../shell/site-links';
import { contactCards } from '../contact-cards';
import { ContactsPage } from '../ContactsPage';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);
vi.mock('../../../../csp/request-nonce', () => ({ requestNonce: () => Promise.resolve('n0nce') }));

const ALL: SiteLinks = {
  bot: 'https://t.me/test_bot',
  botHandle: '@test_bot',
  channel: 'https://t.me/test_channel',
  support: 'https://t.me/test_support',
};
const NONE: SiteLinks = { bot: null, botHandle: null, channel: null, support: null };

const links = vi.hoisted((): { value: SiteLinks } => ({
  value: { bot: null, botHandle: null, channel: null, support: null },
}));
vi.mock('../../shell/site-links', () => ({ siteLinks: () => links.value }));

beforeEach(() => {
  links.value = ALL;
});

// The cards' list (the trail above it is a list too).
function cardList(): HTMLElement {
  const list = screen.getByRole('main').querySelector('ul');
  if (list === null) throw new Error('no card list');
  return list;
}

describe('contactCards', () => {
  it('support, bot, channel and the hours, each link with its @name', () => {
    expect(contactCards(ALL)).toEqual([
      { kind: 'support', href: ALL.support, handle: '@test_support' },
      { kind: 'bot', href: ALL.bot, handle: '@test_bot' },
      { kind: 'channel', href: ALL.channel, handle: '@test_channel' },
      { kind: 'hours', href: null, handle: null },
    ]);
  });

  it('leaves out every card whose link is not configured; the hours stay', () => {
    expect(contactCards(NONE)).toEqual([{ kind: 'hours', href: null, handle: null }]);
    expect(
      contactCards({ ...NONE, bot: ALL.bot, botHandle: ALL.botHandle }).map((c) => c.kind),
    ).toEqual(['bot', 'hours']);
  });

  it('a link without a readable @name (a private invite, a numeric path) shows no handle', () => {
    const cards = contactCards({
      ...NONE,
      channel: 'https://t.me/+AbCdEf123',
      support: 'https://t.me/c/12345/6',
    });
    expect(cards.map((card) => card.handle)).toEqual([null, null, null]);
  });
});

describe.each(['uz', 'ru'] as const)('the contacts page (%s)', (locale) => {
  const copy = MESSAGES[locale];
  const t = copy.site.contacts;
  const prefix = locale === 'uz' ? '' : '/ru';
  const draw = async () => render(await settleServerTree(await ContactsPage({ locale })));

  it('the title, the approved sentence about support, and one card per way to reach us', async () => {
    await draw();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      copy.site.meta.contacts.title,
    );
    expect(screen.getByText(copy.site.why.items.support.text)).toBeInTheDocument();
    const cards = within(cardList()).getAllByRole('listitem');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      t.support.title,
      t.bot.title,
      t.channel.title,
      t.hours.title,
    ]);
    // The hours are the help screen's own text.
    expect(cards[3]).toHaveTextContent(copy.account.help.ask.hours);
    expect(within(cards[3] as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('every link leaves the site safely and says where it goes', async () => {
    await draw();
    const expected = [
      [t.support.cta, ALL.support],
      [t.bot.cta, ALL.bot],
      [t.channel.cta, ALL.channel],
    ] as const;
    for (const [name, href] of expected) {
      const link = within(cardList()).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getByText('@test_support')).toBeInTheDocument();
    expect(screen.getByText('@test_bot')).toBeInTheDocument();
  });

  it('with nothing configured only the hours are left, and no link is drawn in the cards', async () => {
    links.value = NONE;
    await draw();
    const cards = within(cardList()).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    expect(within(cardList()).queryAllByRole('link')).toEqual([]);
  });

  it('the trail and its BreadcrumbList; no company details, no other structured data', async () => {
    const { container } = await draw();
    const trail = screen.getByRole('navigation', {
      name: copy.site.product.common.breadcrumb.label,
    });
    expect(within(trail).getByRole('link')).toHaveAttribute('href', prefix === '' ? '/' : prefix);
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? 'null') as Record<string, unknown>,
    );
    expect(blocks.map((block) => block['@type'])).toEqual(['BreadcrumbList']);
    // No requisites until the lawyer's answer (P8-Q10): no tax number, account or phone.
    expect(container.textContent).not.toMatch(/\bSTIR\b|\bINN\b|\bИНН\b|\+998|\d{9,}/);
  });
});
