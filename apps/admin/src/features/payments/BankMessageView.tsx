import type { AdminBankMessageResponse } from '@repo/shared';
import { useTranslations } from 'use-intl';
import { useAdmin } from '../../app/admin-context';
import { formatDateTime } from '../../lib/format';
import { JsonBlock } from '../common/JsonBlock';
import { KeyValues } from '../common/KeyValues';
import { MoneyCell } from '../common/MoneyCell';
import { Tag } from '../common/Tag';

/**
 * One bank notification as the API returns it. The raw text and balance are OWNER-only
 * (`payments.bankMessageRaw`): for other roles the API sends null and the panel says so. OWNER
 * also gets null when the text was purged or the balance did not parse, so the notice follows the
 * permission, not the null. The text is a plain text node: never rendered as HTML.
 */
export function BankMessageView({ message }: { message: AdminBankMessageResponse }) {
  const t = useTranslations();
  const canSeeRaw = useAdmin().permissions.includes('payments.bankMessageRaw');
  const hidden = canSeeRaw ? '—' : t('admin.payments.message.hidden');
  return (
    <>
      <KeyValues
        rows={[
          {
            key: 'parse',
            label: t('admin.payments.message.parse'),
            value: (
              <Tag tone={message.parseStatus === 'PARSED' ? 'ok' : 'warn'}>
                {message.parseStatus}
              </Tag>
            ),
          },
          { key: 'source', label: t('admin.payments.message.source'), value: message.source },
          {
            key: 'channel',
            label: t('admin.payments.message.channel'),
            value: message.channel ?? hidden,
          },
          {
            key: 'direction',
            label: t('admin.payments.message.direction'),
            value: message.direction ?? '—',
          },
          {
            key: 'amount',
            label: t('admin.payments.col.amount'),
            value: message.amountTiyin ? <MoneyCell tiyin={message.amountTiyin} /> : '—',
          },
          {
            key: 'balance',
            label: t('admin.payments.message.balanceAfter'),
            value: message.balanceAfterTiyin ? (
              <MoneyCell tiyin={message.balanceAfterTiyin} />
            ) : (
              hidden
            ),
          },
          {
            key: 'card',
            label: t('admin.payments.col.card'),
            value: message.last4 ? `•${message.last4}` : '—',
          },
          {
            key: 'bankTxn',
            label: t('admin.payments.message.bankTime'),
            value: message.bankTxnAt ? formatDateTime(message.bankTxnAt) : '—',
          },
          {
            key: 'tg',
            label: t('admin.payments.message.tgTime'),
            value: formatDateTime(message.tgDate),
          },
          ...(message.rejectReason
            ? [
                {
                  key: 'reject',
                  label: t('admin.payments.message.reject'),
                  value: message.rejectReason,
                },
              ]
            : []),
        ]}
      />
      <h3 className="m-0 text-[13px] leading-[18px] font-extrabold">
        {t('admin.payments.message.raw')}
      </h3>
      {message.text === null ? (
        <p className="m-0 rounded-[10px] bg-muted px-3 py-2.5 text-xs leading-4 font-semibold text-foreground-secondary">
          {canSeeRaw
            ? t('admin.payments.message.rawPurged')
            : t('admin.payments.message.rawOwnerOnly')}
        </p>
      ) : (
        <JsonBlock label={t('admin.payments.message.raw')} text={message.text} />
      )}
    </>
  );
}
