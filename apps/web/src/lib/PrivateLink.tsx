import Link from 'next/link';
import type { ComponentPropsWithoutRef } from 'react';
import { zoneOf } from '../features/site/analytics/zones';

type PrivateLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  href: string;
  /** Passed to next/link for a link that stays on the private pages. */
  prefetch?: boolean;
};

/**
 * A link of the private pages (the store, the login, the account pages, the Mini App), the
 * mirror of SiteLink (phase 8 S5): within the private pages it is a next/link (a client-side
 * navigation), but into the marketing pages, or anywhere whose zone is not known, it is a plain
 * `<a>`. The browser then loads the marketing page anew, so its analytics tracker is never mounted
 * in the store's document, and Back returns to a fresh store document without it. The look, the
 * accessible name and the locale-prefixed href are the caller's, unchanged.
 */
export function PrivateLink({ href, prefetch, ...rest }: PrivateLinkProps) {
  if (zoneOf(href) !== 'private') return <a href={href} {...rest} />;
  return <Link href={href} prefetch={prefetch} {...rest} />;
}
