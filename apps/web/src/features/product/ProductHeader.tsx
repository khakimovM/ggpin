'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { Badge, Icon } from '@repo/ui';
import { Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ProductImage } from '../catalog/ProductImage';

export interface ProductHeaderProps {
  product: CatalogProductDetail;
  /** `compact`: the Mini App card (88 px picture). `roomy`: the web header (140 px). */
  size?: 'compact' | 'roomy';
  /** Faded while the product cannot be sold (Product.dc.html `unavailable`). */
  dimmed?: boolean;
}

/** Picture, name, the catalog's one-line description and the delivery / region badges. */
export function ProductHeader({ product, size = 'compact', dimmed = false }: ProductHeaderProps) {
  const t = useTranslations('store.catalog');
  const roomy = size === 'roomy';
  return (
    <section
      className={`flex items-center rounded-[24px] border border-border bg-card ${roomy ? 'gap-3.5 p-3 md:gap-5 md:p-4' : 'gap-3.5 p-3'} ${dimmed ? 'opacity-60' : ''}`}
    >
      <span
        className={`relative block shrink-0 overflow-hidden rounded-[20px] bg-muted ${roomy ? 'size-[88px] md:size-[140px]' : 'size-[88px]'}`}
      >
        <ProductImage src={product.imageUrl} alt="" decorative sizes={roomy ? '140px' : '88px'} />
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <h1
          className={`m-0 font-extrabold break-words ${roomy ? 'font-display text-2xl leading-[1.15] tracking-[-.035em] md:text-3xl' : 'text-xl leading-[25px] tracking-[-.01em]'}`}
        >
          {product.name}
        </h1>
        {product.description !== null ? (
          <span className="text-[13px] leading-[18px] font-medium text-pretty text-foreground-secondary">
            {product.description}
          </span>
        ) : null}
        <span className="mt-0.5 flex flex-wrap gap-1.5">
          {product.isAuto ? (
            <Badge variant="auto" icon={<Icon icon={Zap} size={12} />}>
              {t('badge.auto')}
            </Badge>
          ) : null}
          {product.regionBadge !== null ? (
            <Badge variant="region">{product.regionBadge}</Badge>
          ) : null}
        </span>
      </span>
    </section>
  );
}
