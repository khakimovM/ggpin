'use client';

import { Button, Icon } from '@repo/ui';
import { House, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SupportLinkButton } from '../support/SupportLinkButton';
import type { HeroKind } from './order-status';

export interface OrderActionsProps {
  kind: HeroKind;
  homeHref: string;
  /** The product's own page: "buy again" and "try again" go there. */
  productHref: string;
}

/** The buttons under an order, by what the order is (Checkout.dc.html `actionsBy`). */
export function OrderActions({ kind, homeHref, productHref }: OrderActionsProps) {
  const t = useTranslations('store.order');
  const home = (variant: 'outline' | 'ghost') => (
    <Button asChild variant={variant} size="lg" className="w-full">
      <Link href={homeHref}>
        <Icon icon={House} size={17} />
        {t('actions.home')}
      </Link>
    </Button>
  );
  const again = (
    <Button asChild size="lg" glow className="w-full">
      <Link href={productHref}>
        <Icon icon={ShoppingBag} size={17} />
        {t('actions.again')}
      </Link>
    </Button>
  );

  switch (kind) {
    case 'paid':
    case 'queued':
    case 'processing':
      return (
        <div className="flex flex-col gap-2">
          {home('outline')}
          <LeaveNote />
        </div>
      );
    case 'review':
      return (
        <div className="flex flex-col gap-2">
          <SupportLinkButton className="w-full">{t('actions.support')}</SupportLinkButton>
          {home('ghost')}
          <LeaveNote />
        </div>
      );
    case 'delivered':
    case 'voucher':
      return <div className="flex flex-col gap-2">{again}</div>;
    case 'failed':
    case 'refunded':
      return (
        <div className="flex flex-col gap-2">
          <Button asChild size="lg" glow className="w-full">
            <Link href={productHref}>{t('actions.retry')}</Link>
          </Button>
          <SupportLinkButton className="w-full">{t('actions.support')}</SupportLinkButton>
        </div>
      );
    case 'cancelled':
      return (
        <div className="flex flex-col gap-2">
          <SupportLinkButton className="w-full">{t('actions.support')}</SupportLinkButton>
          {home('ghost')}
        </div>
      );
  }
}

function LeaveNote() {
  const t = useTranslations('store.order');
  return (
    <p className="m-0 text-center text-[13px] leading-[18px] font-semibold text-foreground-muted">
      {t('leaveNote')}
    </p>
  );
}
