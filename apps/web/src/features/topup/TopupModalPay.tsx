'use client';

import { Button, ErrorState, Skeleton } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { isApiError } from '../../lib/api/errors';
import { useFormatMoney } from '../../lib/format/money';
import { useCountdown } from '../auth/use-countdown';
import { PayBar } from '../pay/PayBar';
import { PayBody } from '../pay/PayBody';
import { PayFinal } from '../pay/PayFinal';
import { SupportLinkButton } from '../support/SupportLinkButton';
import { CancelDialog } from './CancelDialog';
import { useTopupIntent } from './use-intent-status';
import { useCancelIntent } from './use-open-pay-page';

export interface TopupModalPayProps {
  intentId: string;
  /** "Yangi to'lov" / "Do'konga qaytish": back to the amount step, or out of the modal. */
  onNewPayment: () => void;
  onDone: () => void;
}

/**
 * Step 2 of the web store's top-up modal (PayPage.dc.html mode=store): the SAME payment screen as the
 * pay page (`PayBody`), fed by the signed-in owner's request (`GET /payments/intents/:id`, the
 * session; no link and no token are involved). The ends - credited, expired, cancelled - are the
 * pay page's too. Cancelling asks first.
 */
export function TopupModalPay({ intentId, onNewPayment, onDone }: TopupModalPayProps) {
  const t = useTranslations('store.topup');
  const pay = useTranslations('pay');
  const common = useTranslations('common');
  const query = useTopupIntent(intentId);
  const cancel = useCancelIntent();
  const formatMoney = useFormatMoney();
  const intent = query.data;
  const msLeft = useCountdown(
    intent === undefined ? null : Date.parse(intent.expiresAt),
    query.dataUpdatedAt,
  );
  const [asking, setAsking] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={pay('loading')}
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-[210px] rounded-[24px]" />
        <Skeleton className="h-[200px] rounded-[24px]" />
        <Skeleton className="h-[76px] rounded-[20px]" />
      </div>
    );
  }
  if (intent === undefined) {
    const missing = isApiError(query.error) && query.error.status === 404;
    return (
      <ErrorState
        title={missing ? pay('invalid.title') : common('error.network')}
        retryLabel={missing ? t('modal.newPayment') : common('retry')}
        retrying={query.isFetching}
        onRetry={missing ? onNewPayment : () => void query.refetch()}
      />
    );
  }
  if (intent.status === 'PAID') {
    return (
      <PayFinal
        kind="credited"
        burstId={`topup:${intent.intentId}`}
        creditedText={`+${formatMoney(intent.creditedTiyin ?? intent.payAmountTiyin)}`}
        heading="h2"
        actions={
          <Button size="lg" className="w-full" onClick={onDone}>
            {t('modal.backToStore')}
          </Button>
        }
      />
    );
  }
  if (intent.status === 'EXPIRED' || (intent.status === 'PENDING' && msLeft <= 0)) {
    return (
      <PayFinal
        kind="expired"
        heading="h2"
        actions={
          <Button size="lg" className="w-full" onClick={onNewPayment}>
            {t('modal.newPayment')}
          </Button>
        }
      />
    );
  }
  if (intent.status === 'CANCELLED' || intent.card === null) {
    return (
      <PayFinal
        kind="cancelled"
        heading="h2"
        actions={
          <>
            <Button size="lg" className="w-full" onClick={onNewPayment}>
              {t('modal.newPayment')}
            </Button>
            <SupportLinkButton variant="ghost" className="w-full" fallbackToBot>
              {pay('cta.support')}
            </SupportLinkButton>
          </>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <PayBody
        inModal
        payAmountTiyin={intent.payAmountTiyin}
        card={intent.card}
        msLeft={msLeft}
        stale={query.isError}
      />
      <PayBar
        netError={query.isError}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
        onCancel={() => setAsking(true)}
        cancelLabel={t('modal.cancel')}
      />
      <CancelDialog
        open={asking}
        cancelling={cancel.cancelling}
        failed={cancelFailed}
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setCancelFailed(false);
          void cancel.cancel(intentId).then((done) => {
            if (done) setAsking(false);
            else setCancelFailed(true);
          });
        }}
      />
    </div>
  );
}
