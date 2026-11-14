import { Badge, cn, Icon } from '@repo/ui';
import { Clock, Crown, Flame, ImageIcon, Star } from 'lucide-react';
import { SiteLink } from '../shell/SiteLink';
import type { ReactNode } from 'react';
import { ProductImage } from '../../catalog/ProductImage';
import { LINK_FOCUS } from '../shell/nav-config';
import type { LandingTile } from './landing-products';

export interface SiteProductCardLabels {
  popular: string;
  auto: string;
  code: string;
  soldOut: string;
  soon: string;
  soonNote: string;
}

export interface SiteProductCardProps {
  tile: LandingTile;
  /** The product's name as it is shown (the API's, or the page's own for a launch/soon tile). */
  name: string;
  /** Full href, with the locale prefix; `null` for a tile that is not a link. */
  href: string | null;
  /** The price line, built by the caller from the server's price; `null` draws no price line. */
  price: ReactNode | null;
  labels: SiteProductCardLabels;
}

// Stars and Premium are drawn with their glyph on their own tint (as in the Mini App's tiles): the
// seed pictures do not exist yet, and a tile with the glyph reads better than an empty slot.
const GLYPH: Record<string, { icon: typeof Star; box: string; glyph: string }> = {
  'telegram-stars': { icon: Star, box: 'bg-star-soft', glyph: 'text-star' },
  'telegram-premium': { icon: Crown, box: 'bg-premium-soft', glyph: 'text-premium' },
};

const CHIP =
  'inline-flex h-5 items-center gap-1 self-start rounded-xs px-1.5 text-[10px] leading-5 font-extrabold whitespace-nowrap';

function Art({ tile, name }: { tile: LandingTile; name: string }) {
  if (tile.kind === 'soon') {
    // The opacity is on the fill only: the label stays at full contrast. The name is printed under
    // the picture, so this slot adds nothing for assistive technology.
    return (
      <span aria-hidden="true" className="absolute inset-0 grid place-items-center px-2">
        <span className="absolute inset-0 bg-muted opacity-60" />
        <span className="relative flex flex-col items-center gap-1.5 text-center text-xs leading-4 font-bold text-foreground-muted">
          <Icon icon={ImageIcon} size={24} />
          {name}
        </span>
      </span>
    );
  }
  const glyph = GLYPH[tile.slug];
  if (glyph !== undefined) {
    return (
      <span
        aria-hidden="true"
        className={cn('absolute inset-0 grid place-items-center', glyph.box, glyph.glyph)}
      >
        <Icon icon={glyph.icon} size={44} />
      </span>
    );
  }
  return (
    <>
      {/* The empty slot of the design, under the picture: it shows while there is none. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center text-foreground-muted"
      >
        <Icon icon={ImageIcon} size={24} />
      </span>
      <ProductImage
        src={tile.imageUrl ?? ''}
        alt={name}
        sizes="(min-width: 1024px) 20vw, 50vw"
        decorative
      />
    </>
  );
}

/**
 * One tile of the landing's product grid (Site.dc.html `products`). A live tile is a link; a
 * "Tez orada" tile is not (no page exists for it). Every price is the server's: with no price the
 * line is simply not drawn.
 */
export function SiteProductCard({ tile, name, href, price, labels }: SiteProductCardProps) {
  const body = (
    <>
      <span className="relative block aspect-square overflow-hidden rounded-[14px] bg-muted">
        <Art tile={tile} name={name} />
        {tile.featured || tile.regionBadge !== null ? (
          // One flex row for both badges: on a narrow tile (a long Russian label, two columns on a
          // phone) the region badge drops to its own line instead of covering the first one.
          <span className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start gap-1">
            {tile.featured ? (
              <Badge variant="popular" size="sm" icon={<Icon icon={Flame} size={11} />}>
                {labels.popular}
              </Badge>
            ) : null}
            {tile.regionBadge === null ? null : (
              <Badge variant="regionOnImage" size="sm" className="ml-auto">
                {tile.regionBadge}
              </Badge>
            )}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-1.5 px-1.5">
        <span className="text-[15px] leading-5 font-extrabold break-words">{name}</span>
        {tile.kind === 'soon' ? (
          <>
            <span className={cn(CHIP, 'bg-info-soft text-info-text')}>
              <Icon icon={Clock} size={11} />
              {labels.soon}
            </span>
            <span className="text-[13px] leading-[22px] font-semibold text-foreground-muted">
              {labels.soonNote}
            </span>
          </>
        ) : (
          <>
            {tile.delivery === 'auto' ? (
              <span className={cn(CHIP, 'bg-success-soft text-success-text')}>{labels.auto}</span>
            ) : tile.delivery === 'code' ? (
              <span className={cn(CHIP, 'bg-accent-soft text-accent-soft-foreground')}>
                {labels.code}
              </span>
            ) : null}
            {price === null ? null : (
              <span className="flex flex-wrap items-baseline gap-1 text-base leading-[22px] font-extrabold tabular-nums">
                {price}
              </span>
            )}
            {tile.inStock ? null : (
              <span className={cn(CHIP, 'bg-muted text-foreground-muted')}>{labels.soldOut}</span>
            )}
          </>
        )}
      </span>
    </>
  );

  const frame =
    'flex h-full flex-col gap-3 rounded-[20px] border border-border bg-card p-2 pb-3.5 text-foreground no-underline';

  return (
    <li>
      {href === null ? (
        <div className={frame}>{body}</div>
      ) : (
        <SiteLink
          href={href}
          prefetch={false}
          className={cn(
            frame,
            'transition-[transform,box-shadow] duration-base ease-out hover:-translate-y-[3px] hover:text-foreground hover:shadow-md',
            LINK_FOCUS,
          )}
        >
          {body}
        </SiteLink>
      )}
    </li>
  );
}
