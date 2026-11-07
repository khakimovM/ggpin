'use client';

import type { CatalogProductListItem } from '@repo/shared';
import { Icon, StockChip } from '@repo/ui';
import { ArrowUpRight, Crown, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { MONEY_PLACEHOLDER, useFormatMoney } from '../../lib/format/money';
import { ProductImage } from './ProductImage';

// MiniApp.dc.html `home`, the "Telegram" section: Stars and Premium are drawn as two tall tiles
// with their own glow. The two products are known by name (CLAUDE.md section 1: built first);
// any other product in that category gets the neutral tile.
const TONE: Record<string, { glow: string; art: string; glyph: typeof Star }> = {
  'telegram-stars': {
    glow: 'bg-[radial-gradient(120%_90%_at_100%_0%,var(--star-soft)_0%,var(--card)_62%)]',
    art: 'rounded-full bg-[radial-gradient(circle_at_32%_28%,color-mix(in_oklab,var(--accent)_35%,white)_0%,var(--accent)_45%,var(--star)_100%)] rotate-[10deg]',
    glyph: Star,
  },
  'telegram-premium': {
    glow: 'bg-[radial-gradient(120%_90%_at_100%_0%,var(--premium-soft)_0%,var(--card)_62%)]',
    art: 'rounded-[20px] bg-[linear-gradient(145deg,color-mix(in_oklab,var(--premium)_70%,white),var(--premium))] -rotate-[8deg]',
    glyph: Crown,
  },
};
const NEUTRAL = {
  glow: 'bg-card',
  art: 'rounded-[20px] bg-primary-soft rotate-[6deg]',
  glyph: Star,
};

export function TelegramProductTile({
  product,
  href,
}: {
  product: CatalogProductListItem;
  href: string;
}) {
  const t = useTranslations('store.catalog');
  const formatMoney = useFormatMoney();
  const tone = TONE[product.slug] ?? NEUTRAL;
  const price = product.fromPriceTiyin === null ? null : formatMoney(product.fromPriceTiyin);

  return (
    <Link
      href={href}
      prefetch={false}
      className={`relative flex min-h-48 flex-col justify-between gap-3 overflow-hidden rounded-3xl border border-border p-4 text-foreground no-underline transition duration-instant active:scale-[.97] ${tone.glow}`}
    >
      <span
        className={`relative grid size-16 place-items-center overflow-hidden text-white shadow-md ${tone.art}`}
      >
        <Icon icon={tone.glyph} size={30} />
        {/* Over the glyph only when there is a picture: it must not hide the star or the crown. */}
        <ProductImage src={product.imageUrl} alt={product.name} sizes="64px" decorative />
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-[17px] leading-[22px] font-extrabold break-words">
          {product.name}
        </span>
        {price === null || price === MONEY_PLACEHOLDER ? null : (
          <span className="text-[13px] leading-[18px] font-bold text-foreground-secondary tabular-nums">
            {t.rich('fromPrice', { price, muted: (chunks) => <span>{chunks}</span> })}
          </span>
        )}
        {product.inStock ? null : (
          <StockChip state="soldOut" label={t('soldOut')} className="self-start" />
        )}
      </span>
      <span
        aria-hidden="true"
        className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-muted text-foreground-secondary"
      >
        <Icon icon={ArrowUpRight} size={16} />
      </span>
    </Link>
  );
}
