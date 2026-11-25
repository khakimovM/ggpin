import Link from 'next/link';
import type { ComponentPropsWithoutRef } from 'react';
import { zoneOf } from '../analytics/zones';

/**
 * True when following `href` leaves the marketing pages: an outside URL, or a path of ours that is
 * not a marketing page (the store and its pages, the login, the Mini App, the payment page).
 * Anything that is not a plain same-site path counts as leaving (zoneOf fails closed): a full load.
 */
export function leavesMarketing(href: string): boolean {
  return zoneOf(href) !== 'marketing';
}

type SiteLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  href: string;
  /** Passed to next/link for a link that stays on the marketing pages. */
  prefetch?: boolean;
};

/**
 * A link of the marketing pages (phase 8 S5, audit M2): between marketing pages it is a next/link
 * (a client-side navigation), but into any other zone it is a plain `<a>`, so the browser loads
 * the page anew and the analytics tracker of the marketing pages does not live on in the store,
 * the login or the account pages. The look and the accessible name are the caller's, unchanged.
 * The href is the caller's too, with its locale prefix (storePath, loginPath, localizedPath).
 */
export function SiteLink({ href, prefetch, ...rest }: SiteLinkProps) {
  if (leavesMarketing(href)) return <a href={href} {...rest} />;
  return <Link href={href} prefetch={prefetch} {...rest} />;
}
