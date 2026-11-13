import { Icon } from '@repo/ui';
import { MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { LANDING_OUTLINE_LINK } from '../landing/landing-styles';

/**
 * "Yordamga yozish" under the heading of a FAQ block (Site.dc.html `#savollar`): the support chat,
 * opened outside the site. With `internal`, a page of the site instead (the FAQ page's way to the
 * contacts when no support chat is configured), opened in the same tab like any site link.
 */
export function FaqSupportLink({
  href,
  label,
  internal = false,
}: {
  href: string;
  label: string;
  internal?: boolean;
}) {
  const content = (
    <>
      <Icon icon={MessageCircle} size={16} />
      {label}
    </>
  );
  if (internal) {
    return (
      <Link href={href} prefetch={false} className={LANDING_OUTLINE_LINK}>
        {content}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LANDING_OUTLINE_LINK}>
      {content}
    </a>
  );
}
