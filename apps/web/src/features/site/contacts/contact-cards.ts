import { supportHandle } from '../../account/referral-link';
import type { SiteLinks } from '../shell/site-links';

// The cards of the contacts page (P8-Q10): the support chat, the bot, the channel and the
// operators' hours. No company details (requisites) until the lawyer's answer (D-57).

export type ContactKind = 'support' | 'bot' | 'channel' | 'hours';

export interface ContactCard {
  kind: ContactKind;
  /** Where the card's button leads (outside the site); null for the hours, which have none. */
  href: string | null;
  /** The "@name" of a t.me link, shown on the card; null when the link has none. */
  handle: string | null;
}

/**
 * The cards in order. A card whose link is not configured is left out, like every link of the
 * site (a dead link is worse than none, see site-links.ts); the hours are always there.
 */
export function contactCards(links: SiteLinks): ContactCard[] {
  const cards: ContactCard[] = [];
  if (links.support !== null) {
    cards.push({ kind: 'support', href: links.support, handle: supportHandle(links.support) });
  }
  if (links.bot !== null) {
    cards.push({ kind: 'bot', href: links.bot, handle: links.botHandle });
  }
  if (links.channel !== null) {
    cards.push({ kind: 'channel', href: links.channel, handle: supportHandle(links.channel) });
  }
  cards.push({ kind: 'hours', href: null, handle: null });
  return cards;
}
