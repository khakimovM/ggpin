'use client';

import { somToTiyin, type TopupIntent } from '@repo/shared';
import { Button, ErrorState, Sheet, Skeleton } from '@repo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useFormatMoney } from '../../lib/format/money';
import { qk } from '../../lib/query-keys';
import { useTopupModalStore } from '../../stores/topup-modal-store';
import { TopupAmountForm, type BankChoice } from './TopupAmountForm';
import { TopupModalPay } from './TopupModalPay';
import { TopupSteps } from './TopupSteps';
import { TopupUnavailable } from './TopupUnavailable';
import { amountProblem } from './topup-limits';
import type { CreateOutcome } from './topup-outcome';
import { useCreateIntent } from './use-create-intent';
import { useTopupMethods } from './use-topup-methods';

function AmountStep({ onCreated }: { onCreated: (intentId: string) => void }) {
  const t = useTranslations('store.topup');
  const common = useTranslations('common');
  const formatMoney = useFormatMoney();
  const { query, limits } = useTopupMethods();
  const { create, creating, waitMs } = useCreateIntent();
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState<BankChoice>('auto');
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={common('loading')}
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-[88px] rounded-md" />
        <Skeleton className="h-11 rounded-full" />
        <Skeleton className="h-[168px] rounded-[20px]" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={common('error.network')}
        retryLabel={common('retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (limits === null || limits === undefined || outcome?.kind === 'unavailable') {
    return (
      <TopupUnavailable
        retrying={query.isFetching}
        onRetry={() => {
          setOutcome(null);
          void query.refetch();
        }}
      />
    );
  }
  const ready = amount !== '' && amountProblem(amount, limits) === null && !creating && waitMs <= 0;
  const submit = async () => {
    if (!ready) return;
    const result = await create(amount, bank === 'auto' ? undefined : bank);
    if (result === null) return;
    // The web store never opens the pay link: the owner is signed in and sees the card right here.
    if (result.kind === 'created' || result.kind === 'pending' || result.kind === 'conflict') {
      onCreated(result.intentId);
    } else setOutcome(result);
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TopupAmountForm
        wide
        limits={limits}
        amount={amount}
        onAmount={(digits) => {
          setAmount(digits);
          setOutcome(null);
        }}
        bank={bank}
        onBank={setBank}
        outcome={outcome}
        disabled={creating}
        waitSec={Math.ceil(waitMs / 1000)}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          size="lg"
          glow
          loading={creating}
          disabled={!ready}
          className="min-w-[220px]"
        >
          {creating
            ? t('creating')
            : amount === ''
              ? t('continue')
              : t('continueAmount', { amount: formatMoney(somToTiyin(amount).toString()) })}
        </Button>
      </div>
      <span className="sr-only">{common('currency.uzs')}</span>
    </form>
  );
}

/**
 * "Hisobni to'ldirish" in the web store (PayPage.dc.html mode=store, Store.dc.html `modal: topup`):
 * a two-step modal, amount then payment. The payment step is the pay page's own screen. It opens
 * from the header's "+" and from "Mablag' yetarli emas"; when the payment ends the wallet in the
 * header is read again.
 */
export function TopupModal() {
  const t = useTranslations('store.topup');
  const { open, hide } = useTopupModalStore();
  const queryClient = useQueryClient();
  const [intentId, setIntentId] = useState<string | null>(null);

  const close = () => {
    hide();
    // A request that has ended must not greet the next opening with its old end screen; one that
    // still waits is picked up again where it was left.
    const cached =
      intentId === null
        ? undefined
        : queryClient.getQueryData<TopupIntent>(qk.payments.intent(intentId));
    const waiting = cached?.status === 'PENDING' && Date.parse(cached.expiresAt) > Date.now();
    if (!waiting) setIntentId(null);
    // Whatever happened inside, the balance and the waiting request are asked for again.
    void queryClient.invalidateQueries({ queryKey: qk.wallet.all });
    void queryClient.invalidateQueries({ queryKey: qk.payments.all });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && close()}
      title={t('title')}
      closeLabel={t('close')}
      className="md:max-w-[640px]"
    >
      <div className="flex flex-col gap-4 pb-2">
        <TopupSteps current={intentId === null ? 0 : 1} />
        {intentId === null ? (
          <AmountStep onCreated={setIntentId} />
        ) : (
          <TopupModalPay
            intentId={intentId}
            onNewPayment={() => setIntentId(null)}
            onDone={close}
          />
        )}
      </div>
    </Sheet>
  );
}
