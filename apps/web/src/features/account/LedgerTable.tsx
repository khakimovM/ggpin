'use client';

import type { LedgerItem } from '@repo/shared';
import { Icon, cn } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Money } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { HistoryTable, LINK_CLASS, ROW_CLASS, type HistoryColumn } from './HistoryTable';
import { LEDGER_LOOK, isCredit } from './ledger-look';

export function LedgerTable({
  items,
  hrefOf,
}: {
  items: readonly LedgerItem[];
  hrefOf: (item: LedgerItem) => string | undefined;
}) {
  const t = useTranslations('account.history');
  const kind = useTranslations('account.history.ledger.kind');
  const { userDateTime } = useDateFormat();
  const columns: HistoryColumn[] = [
    { key: 'date', label: t('columns.date') },
    { key: 'kind', label: t('columns.operation') },
    { key: 'amount', label: t('columns.amount'), align: 'right' },
    { key: 'action', label: t('columns.action'), hidden: true },
  ];
  return (
    <HistoryTable caption={t('tabs.finance')} columns={columns}>
      {items.map((item) => {
        const look = LEDGER_LOOK[item.kind];
        const href = hrefOf(item);
        const title = <span className="font-extrabold">{kind(item.kind)}</span>;
        return (
          <tr key={item.id} className={ROW_CLASS}>
            <td className="px-5 whitespace-nowrap text-foreground-secondary">
              {userDateTime(new Date(item.createdAt))}
            </td>
            <td className="px-3">
              <span className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-[10px]',
                    look.tone,
                  )}
                >
                  <Icon icon={look.icon} size={16} />
                </span>
                {href === undefined ? (
                  title
                ) : (
                  <Link href={href} className={LINK_CLASS}>
                    {title}
                  </Link>
                )}
              </span>
            </td>
            <td className="px-3 text-right">
              <Money
                tiyin={item.amountTiyin}
                size="md"
                tone={isCredit(item.amountTiyin) ? 'credit' : 'default'}
              />
            </td>
            <td className="pr-4 text-foreground-muted">
              {href === undefined ? null : <Icon icon={ChevronRight} size={17} />}
            </td>
          </tr>
        );
      })}
    </HistoryTable>
  );
}
