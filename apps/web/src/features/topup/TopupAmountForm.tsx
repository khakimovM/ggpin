'use client';

import { somToTiyin, type CardBank } from '@repo/shared';
import { Chip, Icon, MoneyInput, SegmentedControl } from '@repo/ui';
import { Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { errorKey, type ApiErrorCode } from '../../lib/api/errors';
import { useFormatMoney } from '../../lib/format/money';
import { formatTiyinString } from '../../lib/format/tiyin';
import { amountProblem, quickAmounts, type TopupLimits } from './topup-limits';
import { rangeMessage, type CreateOutcome } from './topup-outcome';

export type BankChoice = CardBank | 'auto';

export interface TopupAmountFormProps {
  limits: TopupLimits;
  /** Whole so'm, digits only. */
  amount: string;
  onAmount: (digits: string) => void;
  bank: BankChoice;
  onBank: (bank: BankChoice) => void;
  /** What the server said to the last attempt, shown under the field until the amount changes. */
  outcome: CreateOutcome | null;
  disabled?: boolean;
  /** Seconds left of a 429's `Retry-After` (0 = none): said under the field. */
  waitSec?: number;
  /** Two columns (the web modal): the form beside the "how it works" card. */
  wide?: boolean;
}

/**
 * The amount step of a top-up (TopupMini.dc.html `amount`, PayPage.dc.html store step 1): the
 * `MoneyInput`, the quick amounts, the card type and the three-step explanation. Limits come from
 * the server (`GET /payments/methods`); the texts under the field say what is wrong with the typed
 * amount, and what the server said when it refused one.
 */
export function TopupAmountForm({
  limits,
  amount,
  onAmount,
  bank,
  onBank,
  outcome,
  disabled = false,
  waitSec = 0,
  wide = false,
}: TopupAmountFormProps) {
  const t = useTranslations('store.topup');
  const common = useTranslations('common');
  const root = useTranslations();
  const locale = useLocale();
  const formatMoney = useFormatMoney();
  const som = (digits: string) => formatMoney(somToTiyin(digits).toString());
  const problem = amountProblem(amount, limits);
  const plain = (digits: string) =>
    formatTiyinString(somToTiyin(digits).toString(), locale === 'ru' ? 'ru' : 'uz') ?? digits;

  // A code the server named gets its own text (blocked account, no card, ...).
  const failedText = (code: ApiErrorCode) => root(errorKey(code));

  let serverText: string | undefined;
  if (outcome?.kind === 'range') {
    const message = rangeMessage(outcome.details);
    serverText =
      message.key === 'range'
        ? t('errors.range', {
            min: formatMoney(message.min),
            max: formatMoney(message.max),
            step: formatMoney(message.step),
          })
        : message.key === 'dailyLeft'
          ? t('errors.dailyLeft', { max: formatMoney(message.max) })
          : t(`errors.${message.key}`);
  } else if (waitSec > 0) {
    serverText = t('errors.rateWait', { seconds: waitSec });
  } else if (outcome?.kind === 'rate') {
    serverText = t('errors.rate');
  } else if (outcome?.kind === 'conflict') {
    serverText = t('errors.conflict');
  } else if (outcome?.kind === 'failed') {
    serverText = failedText(outcome.code);
  }
  const stepText = problem === 'step' ? t('errors.step', { step: som(limits.stepSom) }) : undefined;

  const banks: { value: BankChoice; label: string }[] = [
    { value: 'auto', label: t('cardType.auto') },
    ...limits.banks.map((item) => ({
      value: item,
      label: item === 'HUMO' ? t('cardType.humo') : t('cardType.uzcard'),
    })),
  ];

  return (
    <div
      className={`grid items-start gap-5 ${wide ? 'sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]' : ''}`}
    >
      <section className="flex min-w-0 flex-col gap-3">
        <MoneyInput
          label={t('amount.label')}
          value={amount}
          onValueChange={onAmount}
          unit={common('currency.uzs')}
          disabled={disabled}
          min={limits.minSom}
          max={limits.maxSom}
          minError={t('errors.min', { min: som(limits.minSom) })}
          maxError={t('errors.max', { max: som(limits.maxSom) })}
          error={stepText ?? serverText}
          help={t('amount.help', {
            min: som(limits.minSom),
            max: som(limits.maxSom),
            step: som(limits.stepSom),
          })}
        />
        <div className="grid grid-cols-4 gap-2" role="group" aria-label={t('amount.label')}>
          {quickAmounts(limits).map((value) => (
            <Chip
              key={value}
              variant="quick"
              selected={amount === value}
              disabled={disabled}
              onClick={() => onAmount(value)}
              className="w-full px-1"
            >
              {plain(value)}
            </Chip>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm leading-5 font-bold text-foreground-secondary">
            {t('cardType.label')}
          </span>
          <SegmentedControl
            ariaLabel={t('cardType.label')}
            value={bank}
            options={banks}
            onValueChange={onBank}
          />
          <span className="text-[13px] leading-[18px] font-medium text-foreground-muted">
            {t('cardType.help')}
          </span>
        </div>
      </section>
      <section className="flex flex-col gap-3 rounded-[20px] border border-border bg-surface p-4">
        <h2 className="m-0 text-base leading-[22px] font-extrabold">{t('how.title')}</h2>
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {(['one', 'two', 'three'] as const).map((step, index) => (
            <li key={step} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-[26px] shrink-0 place-items-center rounded-full bg-primary-soft text-[13px] font-extrabold text-primary-soft-foreground"
              >
                {index + 1}
              </span>
              <span className="pt-[3px] text-sm leading-5 font-semibold text-pretty">
                {t(`how.${step}`)}
              </span>
            </li>
          ))}
        </ol>
        <span className="flex gap-2 rounded-xl bg-muted px-3 py-2.5 text-[13px] leading-[18px] font-semibold text-foreground-secondary">
          <Icon icon={Info} size={15} className="mt-px shrink-0" />
          {t('how.tail')}
        </span>
      </section>
    </div>
  );
}
