'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { haptics } from '../../telegram/haptics';
import { CustomQty } from './CustomQty';
import { SkuGrid } from './SkuGrid';
import { SkuTabs } from './SkuTabs';
import { layoutOf } from './selection';

export interface PackageSectionProps {
  product: CatalogProductDetail;
  selectedSku: string | null;
  customQty: string;
  onSelectSku: (skuId: string) => void;
  onQtyChange: (value: string) => void;
}

/** Group labels in the order the catalog lists them; null (no group) is not a tab. */
export function tabsOf(product: CatalogProductDetail): string[] {
  const seen: string[] = [];
  for (const sku of product.skus) {
    if (sku.tab !== null && !seen.includes(sku.tab)) seen.push(sku.tab);
  }
  return seen;
}

/**
 * "Miqdor" for a free quantity, "Muddat" for terms (Premium: a Telegram product without a free
 * quantity), "Paketni tanlang" for other packages, with tabs when the catalog groups them.
 */
export function PackageSection({
  product,
  selectedSku,
  customQty,
  onSelectSku,
  onQtyChange,
}: PackageSectionProps) {
  const t = useTranslations('store.product');
  const tabs = tabsOf(product);
  const [pickedTab, setPickedTab] = useState<string | null>(null);
  const selectedTab = product.skus.find((sku) => sku.id === selectedSku)?.tab ?? null;
  const tab = pickedTab ?? selectedTab ?? tabs[0] ?? null;

  if (layoutOf(product) === 'quantity') {
    const { minQty, maxQty } = product;
    if (minQty === null || maxQty === null) return null;
    return (
      <section
        aria-labelledby="package-title"
        className="flex flex-col gap-3 rounded-[24px] border border-border bg-card p-4"
      >
        <h2 id="package-title" className="m-0 text-[17px] leading-[22px] font-extrabold">
          {t('qty.title')}
        </h2>
        <CustomQty
          product={product}
          value={customQty}
          onValueChange={onQtyChange}
          min={minQty}
          max={maxQty}
        />
      </section>
    );
  }

  const terms = product.deliveryType === 'TG_USERNAME';
  const visible = tab === null ? product.skus : product.skus.filter((sku) => sku.tab === tab);
  const title = terms ? t('sku.plans') : t('sku.title');
  return (
    <section
      aria-labelledby="package-title"
      className="flex flex-col gap-3 rounded-[24px] border border-border bg-card p-4"
    >
      <h2 id="package-title" className="m-0 text-[17px] leading-[22px] font-extrabold">
        {title}
      </h2>
      {tabs.length > 1 && tab !== null ? (
        <SkuTabs tabs={tabs} value={tab} onValueChange={setPickedTab} ariaLabel={t('sku.tabs')} />
      ) : null}
      <SkuGrid
        skus={visible}
        selected={selectedSku}
        ariaLabel={title}
        layout={terms ? 'list' : 'grid'}
        onSelect={(skuId) => {
          haptics.selection();
          onSelectSku(skuId);
        }}
      />
    </section>
  );
}
