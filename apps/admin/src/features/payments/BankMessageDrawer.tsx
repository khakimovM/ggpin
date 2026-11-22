import { Drawer, Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { getBankMessage } from '../../lib/api/reads';
import { useDrawerParam } from '../../lib/drawer-param';
import { qk } from '../../lib/query-keys';
import { LoadError } from '../common/ListStates';
import { BankMessageView } from './BankMessageView';

/** The bank-message drawer (`?message=<id>`), opened from a payment or a reconcile example. */
export function BankMessageDrawer() {
  const t = useTranslations();
  const { id, close } = useDrawerParam('message');
  const query = useQuery({
    queryKey: qk.payments.bankMessage(id ?? ''),
    queryFn: ({ signal }) => getBankMessage(id ?? '', signal),
    enabled: id !== null,
  });
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('admin.payments.message.title')}
      closeLabel={t('admin.dialogs.close')}
    >
      {query.data ? (
        <BankMessageView message={query.data} />
      ) : query.isError ? (
        <LoadError
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-2">
          <Skeleton className="h-48 rounded-[10px]" />
          <Skeleton className="h-24 rounded-[10px]" />
        </div>
      )}
    </Drawer>
  );
}
