'use client';

import { BottomActionBar, Icon } from '@repo/ui';
import { ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Money, useFormatMoney } from '../../lib/format/money';
import { useMainButton } from '../../telegram/use-main-button';
import { useTelegram } from '../../telegram/telegram-context';

export interface PriceBarProps {
  variant: 'tg' | 'web';
  /** Server total (`totalTiyin`) of a valid quote; null until there is one. */
  totalTiyin: string | null;
  /** The quote is being fetched. */
  pending: boolean;
  /** Why the button is off (a translated sentence), or undefined when it is on. */
  reason: string | undefined;
  onBuy: () => void;
  /** The checkout sheet is open: in the Mini App the native button is the sheet's now. */
  suspended?: boolean;
}

/**
 * The buy action. In the Mini App it is Telegram's native MainButton, with the reason printed in
 * the page (the native button has no room for it); on the web it is the bottom bar below 1024 px
 * and a block at the end of the sticky panel from 1024 px. It is on only with a confirmed
 * recipient and a live quote, and the amount on it is the quote's, as the server wrote it.
 */
export function PriceBar({
  variant,
  totalTiyin,
  pending,
  reason,
  onBuy,
  suspended = false,
}: PriceBarProps) {
  const t = useTranslations('store.product.buy');
  const formatMoney = useFormatMoney();
  const { webApp } = useTelegram();
  const enabled = reason === undefined && totalTiyin !== null && !pending;
  const price = totalTiyin === null ? null : formatMoney(totalTiyin);

  useMainButton(variant === 'tg' && !suspended ? webApp : null, {
    text: enabled && price !== null ? t('withPrice', { price }) : t('label'),
    enabled,
    loading: pending,
    onClick: () => {
      onBuy();
      return Promise.resolve();
    },
  });

  if (variant === 'tg') {
    return reason === undefined ? null : (
      <p
        role="status"
        className="m-0 text-center text-[13px] leading-[18px] font-bold text-foreground-muted"
      >
        {reason}
      </p>
    );
  }

  const bar = {
    label: t('label'),
    onAction: onBuy,
    price: totalTiyin === null ? undefined : <Money tiyin={totalTiyin} size="lg" />,
    priceLoading: pending,
    disabledReason: reason,
    icon: <Icon icon={ShoppingBag} size={18} />,
  };
  return (
    <>
      <BottomActionBar {...bar} fixed className="lg:hidden" />
      <BottomActionBar {...bar} className="hidden border-0 bg-transparent p-0 lg:flex" />
    </>
  );
}
