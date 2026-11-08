'use client';

import { Button, EmptyState, Icon } from '@repo/ui';
import { PackageX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

/**
 * Product.dc.html `pageState: unavailable`: a 404, out of stock, or a product this page cannot
 * sell yet. The way out is the catalog.
 */
export function ProductUnavailable({ catalogHref }: { catalogHref: string }) {
  const t = useTranslations('store.product.unavailable');
  return (
    <EmptyState
      icon={<Icon icon={PackageX} size={24} />}
      title={t('title')}
      description={t('body')}
      action={
        <Button asChild variant="secondary">
          <Link href={catalogHref}>{t('cta')}</Link>
        </Button>
      }
    />
  );
}
