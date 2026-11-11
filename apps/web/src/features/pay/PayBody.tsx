'use client';

import { tiyinToSom, type TopupCardView } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PayAmount } from './PayAmount';
import { PayCardBlock } from './PayCardBlock';
import { PayCountdown } from './PayCountdown';
import { PayHow } from './PayHow';
import { PayOwnerNote } from './PayOwnerNote';
import { PayRules } from './PayRules';
import { useCopy } from './use-copy';

export interface PayBodyProps {
  payAmountTiyin: string;
  card: TopupCardView;
  msLeft: number;
  /** The last poll failed: the figures may be out of date. */
  stale?: boolean;
  /**
   * The pay page (a stranger may have been sent the link): shows whose account it tops up. The
   * store modal belongs to the signed-in owner and passes `undefined`, so no owner note is drawn.
   */
  ownerHint?: string | null;
  /** Two columns on a wide screen (the page); the modal is always one. */
  wide?: boolean;
  /** In the store's modal the toast sits higher, above the modal's own bottom edge. */
  inModal?: boolean;
}

/**
 * The payment screen proper (PayPage.dc.html `pending`): who it is for, the exact amount, our card,
 * the time left, how to pay and the transfer rules. One component for the pay page and for the
 * web store's top-up modal, so the two can never disagree about the card or the amount.
 */
export function PayBody({
  payAmountTiyin,
  card,
  msLeft,
  stale = false,
  ownerHint,
  wide = false,
  inModal = false,
}: PayBodyProps) {
  const t = useTranslations('pay');
  const { copied, copy } = useCopy<'amount' | 'card'>();
  return (
    <div className="flex flex-col gap-4">
      {ownerHint === undefined ? null : <PayOwnerNote ownerHint={ownerHint} />}
      <div
        className={`grid items-start gap-4 ${wide ? 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : ''}`}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <PayAmount
            payAmountTiyin={payAmountTiyin}
            stale={stale}
            large={wide}
            copied={copied === 'amount'}
            onCopy={() => void copy('amount', amountDigits(payAmountTiyin))}
          />
          <PayCardBlock
            card={card}
            copied={copied === 'card'}
            onCopy={() => void copy('card', card.number)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PayCountdown msLeft={msLeft} />
          <PayHow />
          <PayRules />
        </div>
      </div>
      <div
        role="status"
        className={`pointer-events-none fixed left-1/2 z-30 -translate-x-1/2 ${inModal ? 'bottom-[120px]' : 'bottom-24'}`}
      >
        {copied === null ? null : (
          <span className="flex h-11 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-extrabold whitespace-nowrap text-background shadow-lg animate-[gg-toast-in_var(--dur-base)_var(--ease-out)] motion-reduce:animate-none">
            <Icon icon={Check} size={16} />
            {copied === 'amount' ? t('copiedAmount') : t('copiedCard')}
          </span>
        )}
      </div>
    </div>
  );
}

// The amount in whole so'm, digits only (the bank app wants "50347", not "50 347"). The server's
// string goes through the money module, nothing is computed here.
function amountDigits(payAmountTiyin: string): string {
  return tiyinToSom(BigInt(payAmountTiyin));
}
