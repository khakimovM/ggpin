import type { AdminCreditPreviewResponse } from '@repo/shared';
import { Button, Skeleton } from '@repo/ui';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { formatTiyin } from '../../lib/format';
import { ACTION_FIELD_CODES } from '../common/action-error-text';
import { MoneyCell } from '../common/MoneyCell';
import { Tag } from '../common/Tag';
import { camelKey } from '../../lib/camel-key';
import { TEXT_LINK } from '../common/link-style';

interface Props {
  preview: AdminCreditPreviewResponse | undefined;
  idle: boolean;
  error: string | null;
  onRetry: () => void;
}

/**
 * What the CLI's review:credit prints before it asks anything (`credit-preview`, OWNER): the
 * user who gets the money, their state, why an override is needed and the money already given
 * by hand since the request (D-47). Server values only.
 */
export function CreditPreviewPanel({ preview, idle, error, onRetry }: Props) {
  const t = useTranslations();
  if (idle) return null;
  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 rounded-sm bg-danger-soft px-3 py-2 text-xs leading-4 font-bold text-danger-text"
      >
        <span className="min-w-0 flex-1">{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('admin.states.retry')}
        </Button>
      </div>
    );
  }
  if (preview === undefined) {
    return (
      <div role="status" aria-label={t('admin.states.loading')}>
        <Skeleton className="h-16 rounded-sm" />
      </div>
    );
  }
  const manual = preview.manualCreditsSinceRequest;
  const override = ACTION_FIELD_CODES.find((code) => code === preview.overrideNeeded);
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3 text-xs leading-4">
      <span className="font-extrabold">{t('admin.payments.review.preview.title')}</span>
      <span className="flex flex-wrap items-center gap-1.5 font-bold">
        <span className="text-foreground-muted">{t('admin.payments.review.preview.user')}</span>
        <Link to={`/users/${preview.userId}`} className={TEXT_LINK}>
          {preview.userId}
        </Link>
        <MoneyCell tiyin={preview.amountTiyin} className="font-extrabold" />
      </span>
      <span className="flex flex-wrap gap-1.5">
        {preview.blocked ? (
          <Tag tone="bad">{t('admin.payments.review.preview.blocked')}</Tag>
        ) : null}
        {preview.purchaseFrozen ? (
          <Tag tone="warn">{t('admin.payments.review.preview.frozen')}</Tag>
        ) : null}
        {preview.overLimit ? (
          <Tag tone="warn">{t('admin.payments.review.preview.overLimit')}</Tag>
        ) : null}
        {preview.needsBankVerification ? (
          <Tag tone="warn">{t('admin.payments.review.preview.bank')}</Tag>
        ) : null}
        <Tag tone="mute">
          {t('admin.payments.review.preview.age', { count: preview.accountAgeDays })}
        </Tag>
      </span>
      {preview.overrideNeeded === null ? null : (
        <span className="font-bold text-warning-text">
          {t('admin.payments.review.preview.override', {
            reason: t(
              override === undefined
                ? 'admin.fieldErrors.unknown'
                : `admin.fieldErrors.${camelKey(override)}`,
            ),
          })}
        </span>
      )}
      <span className="font-semibold text-foreground-muted tabular-nums">
        {t('admin.payments.review.preview.manual', {
          adjust: manual.adjust.count,
          credit: manual.reviewCredit.count,
          adjustSum: `${formatTiyin(manual.adjust.sumTiyin)} ${t('admin.money.som')}`,
          creditSum: `${formatTiyin(manual.reviewCredit.sumTiyin)} ${t('admin.money.som')}`,
        })}
      </span>
    </div>
  );
}
