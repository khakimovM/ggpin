import { cn, Icon } from '@repo/ui';
import { Send } from 'lucide-react';
import { SiteLink } from '../shell/SiteLink';
import { LANDING_CTA_BOX, LANDING_CTA_PRIMARY } from '../landing/landing-styles';
import { LINK_FOCUS } from '../shell/nav-config';
import { BUY_BUTTON_SIZE, TELEGRAM_BUTTON_SIZE } from './product-styles';

// The buttons of a product page that do not depend on a chosen package (the one that does, the
// buy button of a priced list, lives in PackagePicker). Not `buttonVariants()`: that is a client
// module and cannot be called on the server.

/**
 * Site.dc.html `page: product`: the Telegram button has no fill, only its border on the page (the
 * landing's secondary button sits on the card colour); hovered, it takes the muted fill.
 */
const TELEGRAM_BUTTON = cn(
  LANDING_CTA_BOX,
  'border-[1.5px] border-border text-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground',
  LINK_FOCUS,
  TELEGRAM_BUTTON_SIZE,
);

/** "Telegramʼda": the bot. Drawn only when a bot is configured. */
export function TelegramButton({ href, label }: { href: string | null; label: string }) {
  if (href === null) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={TELEGRAM_BUTTON}>
      <Icon icon={Send} size={17} />
      {label}
    </a>
  );
}

/** The buy button without a package behind it: it leads into the store, which asks for the rest. */
export function BuyLink({ href, label }: { href: string; label: string }) {
  return (
    <SiteLink href={href} prefetch={false} className={cn(LANDING_CTA_PRIMARY, BUY_BUTTON_SIZE)}>
      {label}
    </SiteLink>
  );
}

/** The buy button of a product that is not for sale (the catalog says it does not exist). */
export function BuyDisabled({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      className="flex min-h-14 flex-[1_1_260px] cursor-not-allowed items-center justify-center rounded-tile bg-muted px-4 py-2 text-base leading-5 font-extrabold text-foreground-muted"
    >
      {label}
    </button>
  );
}
