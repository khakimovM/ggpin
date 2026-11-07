'use client';

import type { CatalogProductListItem } from '@repo/shared';
import { Badge, Card, Icon, StockChip } from '@repo/ui';
import { Star, Zap, Ticket } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { MONEY_PLACEHOLDER, useFormatMoney } from '../../lib/format/money';
import { ProductImage } from './ProductImage';

export interface ProductCardProps {
  product: CatalogProductListItem;
  href: string;
  /** compact: the Mini App grid (4:3 picture); roomy: the web grid (square picture). */
  size?: 'compact' | 'roomy';
}

/**
 * One product in the grid (MiniApp.dc.html `home`, Store.dc.html `catalog`). The price is the
 * server's `fromPriceTiyin`; without one (no fresh price) there is no price line at all, never a
 * stale or invented figure. A sold-out product stays a link: its page says what is going on.
 */
export function ProductCard({ product, href, size = 'compact' }: ProductCardProps) {
  const t = useTranslations('store.catalog');
  const formatMoney = useFormatMoney();
  const price = product.fromPriceTiyin === null ? null : formatMoney(product.fromPriceTiyin);
  const hasPrice = price !== null && price !== MONEY_PLACEHOLDER;
  const roomy = size === 'roomy';

  return (
    <Card
      asChild
      interactive
      padding="none"
      className={roomy ? 'rounded-[22px] p-2 pb-4' : 'rounded-[20px] p-1.5 pb-3'}
    >
      <Link href={href} prefetch={false} className="flex flex-col gap-2.5 text-foreground">
        <span
          className={`relative block overflow-hidden bg-muted ${roomy ? 'aspect-square rounded-2xl' : 'aspect-[4/3] rounded-[15px]'}`}
        >
          <ProductImage
            src={product.imageUrl}
            alt={product.name}
            sizes={roomy ? '(min-width: 1024px) 20vw, 33vw' : '50vw'}
          />
          {product.isFeatured ? (
            <Badge
              variant="popular"
              size="sm"
              icon={<Icon icon={Star} size={11} />}
              className="pointer-events-none absolute top-1.5 left-1.5"
            >
              {t('badge.popular')}
            </Badge>
          ) : null}
          {product.regionBadge === null ? null : (
            <Badge
              variant="regionOnImage"
              size="sm"
              className="pointer-events-none absolute top-1.5 right-1.5"
            >
              {product.regionBadge}
            </Badge>
          )}
        </span>
        <span className="flex flex-col gap-1.5 px-1.5">
          <span
            className={`line-clamp-2 min-h-10 font-extrabold break-words ${roomy ? 'text-base leading-[21px]' : 'text-[15px] leading-5'}`}
          >
            {product.name}
          </span>
          {product.isAuto ? (
            <Badge variant="auto" icon={<Icon icon={Zap} size={11} />} className="self-start">
              {t('badge.auto')}
            </Badge>
          ) : product.deliveryType === 'VOUCHER' ? (
            <Badge variant="code" icon={<Icon icon={Ticket} size={11} />} className="self-start">
              {t('badge.code')}
            </Badge>
          ) : null}
          {hasPrice ? (
            <span className="flex items-baseline gap-1 text-[15px] leading-5 font-extrabold tabular-nums">
              {t.rich('fromPrice', {
                price,
                muted: (chunks) => (
                  <span className="text-xs leading-4 font-semibold text-foreground-muted">
                    {chunks}
                  </span>
                ),
              })}
            </span>
          ) : null}
          {product.inStock ? null : (
            <StockChip state="soldOut" label={t('soldOut')} className="self-start" />
          )}
        </span>
      </Link>
    </Card>
  );
}
