import { cn, HIT_AREA_LINK, Icon } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Fragment } from 'react';
import { LANDING_CONTAINER } from '../landing/landing-styles';
import { LINK_FOCUS } from '../shell/nav-config';

export interface Crumb {
  label: string;
  /** Full href with the locale prefix; the last crumb (the page itself) has none. */
  href: string | null;
}

const LINK = cn(
  'relative inline-flex items-center text-foreground-muted no-underline hover:text-foreground',
  HIT_AREA_LINK,
  LINK_FOCUS,
);

/**
 * Site.dc.html breadcrumb: Bosh sahifa > Mahsulotlar > the product. The last one is the page
 * itself (`aria-current`). The same trail goes to search engines as `BreadcrumbList`.
 */
export function Breadcrumbs({ label, items }: { label: string; items: readonly Crumb[] }) {
  return (
    <div className={cn(LANDING_CONTAINER, 'pt-[clamp(16px,2vw,28px)]')}>
      <nav aria-label={label}>
        <ol className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0 text-[13px] leading-5 font-semibold text-foreground-muted">
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {index === 0 ? null : (
                <li aria-hidden="true" className="flex">
                  <Icon icon={ChevronRight} size={12} />
                </li>
              )}
              <li className="flex">
                {item.href === null ? (
                  <span aria-current="page" className="text-foreground">
                    {item.label}
                  </span>
                ) : (
                  <Link href={item.href} prefetch={false} className={LINK}>
                    {item.label}
                  </Link>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>
    </div>
  );
}
