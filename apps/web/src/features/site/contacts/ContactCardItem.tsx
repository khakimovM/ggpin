import { cn, Icon } from '@repo/ui';
import { Bot, Clock, Headset, Megaphone, MessageCircle, Send, type LucideIcon } from 'lucide-react';
import { LANDING_OUTLINE_LINK } from '../landing/landing-styles';
import type { ContactKind } from './contact-cards';

export interface ContactCardView {
  kind: ContactKind;
  title: string;
  /** One sentence about what the channel is for; the hours card has none. */
  text: string | null;
  /** The line in bold: the "@name" of the link, or the hours. */
  value: string | null;
  /** The button: where it leads and what it says. */
  action: { href: string; label: string } | null;
}

interface CardLook {
  icon: LucideIcon;
  /** The icon square's colours (the landing's "Nega biz?" cards). */
  tint: string;
  /** The button's icon; the hours card has no button. */
  actionIcon: LucideIcon | null;
}

const LOOK: Record<ContactKind, CardLook> = {
  support: {
    icon: Headset,
    tint: 'bg-accent-soft text-accent-soft-foreground',
    actionIcon: MessageCircle,
  },
  bot: { icon: Bot, tint: 'bg-primary-soft text-primary-soft-foreground', actionIcon: Send },
  channel: { icon: Megaphone, tint: 'bg-info-soft text-info', actionIcon: Send },
  hours: { icon: Clock, tint: 'bg-success-soft text-success', actionIcon: null },
};

/**
 * One card of the contacts page, in the look of the landing's "Nega biz?" cards: the tinted icon,
 * the title, a sentence, the handle or the hours in bold, and the outlined button of the FAQ block
 * at the bottom. A link leaves the site, so it opens in a new tab without an opener.
 */
export function ContactCardItem({ view }: { view: ContactCardView }) {
  const { icon, tint, actionIcon } = LOOK[view.kind];
  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-6">
      <span
        aria-hidden="true"
        className={cn('grid size-12 place-items-center rounded-[14px]', tint)}
      >
        <Icon icon={icon} size={22} />
      </span>
      <h2 className="mx-0 mt-1 mb-0 text-lg leading-6 font-extrabold">{view.title}</h2>
      {view.text === null ? null : (
        <p className="m-0 text-[15px] leading-[22px] font-medium text-foreground-secondary">
          {view.text}
        </p>
      )}
      {view.value === null ? null : (
        <p className="m-0 text-[15px] leading-[22px] font-bold break-words text-foreground">
          {view.value}
        </p>
      )}
      {view.action === null ? null : (
        <a
          href={view.action.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(LANDING_OUTLINE_LINK, 'mt-auto')}
        >
          {actionIcon === null ? null : <Icon icon={actionIcon} size={16} />}
          {view.action.label}
        </a>
      )}
    </li>
  );
}
