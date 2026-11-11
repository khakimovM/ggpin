'use client';

import { HIT_AREA_44, Icon, Skeleton } from '@repo/ui';
import { Plus, RefreshCw, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MONEY_PLACEHOLDER, useFormatMoney } from '../../lib/format/money';
import { useTopupModalStore } from '../../stores/topup-modal-store';
import { useWallet } from '../wallet/use-wallet';

/**
 * The balance in the store header (Store.dc.html: soft pill, a wallet icon, the amount and a round
 * "+"). The amount is the server's. The "+" opens the top-up modal.
 */
export function WalletPill() {
  const t = useTranslations('web.nav');
  const common = useTranslations('common');
  const card = useTranslations('wallet.card');
  const formatMoney = useFormatMoney();
  const wallet = useWallet();

  if (wallet.isPending) {
    return <Skeleton className="h-11 w-36 rounded-full" />;
  }
  if (wallet.isError) {
    // No balance to show: a dash with a retry, never a made-up number.
    return (
      <button
        type="button"
        aria-label={`${card('error.title')}. ${common('retry')}`}
        onClick={() => void wallet.refetch()}
        className="flex h-11 items-center gap-2 rounded-full bg-primary-soft px-3 text-sm font-extrabold text-primary-soft-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon icon={Wallet} size={16} />
        <span aria-hidden="true">{MONEY_PLACEHOLDER}</span>
        <Icon icon={RefreshCw} size={15} />
      </button>
    );
  }
  const amount = formatMoney(wallet.data.balanceTiyin);
  return (
    <span className="flex h-11 items-center gap-1 rounded-full bg-primary-soft pr-1 pl-3 text-sm font-extrabold whitespace-nowrap text-primary-soft-foreground tabular-nums">
      <Icon icon={Wallet} size={16} className="mr-1" />
      <span data-testid="header-balance">{amount}</span>
      <button
        type="button"
        aria-label={t('topUp')}
        onClick={() => useTopupModalStore.getState().show()}
        className={`relative ml-1.5 grid size-9 place-items-center rounded-full bg-primary text-primary-foreground transition duration-fast ease-standard hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${HIT_AREA_44}`}
      >
        <Icon icon={Plus} size={17} />
      </button>
    </span>
  );
}
