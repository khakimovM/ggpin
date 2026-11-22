import { Skeleton, cn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getFragment } from '../../lib/api/people';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { Panel } from '../common/Panel';
import { PendingActions } from '../common/PendingActions';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';
import { MockNote } from '../common/MockNote';

const TONE = { ACTIVE: 'ok', DEAD: 'bad', NONE: 'mute' } as const;

function Fragment() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.infra.fragment(),
    queryFn: ({ signal }) => getFragment(signal),
    refetchInterval: 30_000,
  });
  const data = query.data;
  return (
    <>
      <PageHeader title={t('admin.nav.fragment')} sub={t('admin.fragment.sub')} />
      <MockNote />
      {data ? (
        <Panel>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'grid size-11 place-items-center rounded-[12px]',
                data.status === 'ACTIVE'
                  ? 'bg-success-soft text-success'
                  : data.status === 'DEAD'
                    ? 'bg-danger-soft text-danger'
                    : 'bg-muted text-foreground-muted',
              )}
            >
              <KeyRound size={20} aria-hidden="true" />
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-base leading-5 font-extrabold">
                {t(`admin.fragment.status.${data.status}`)}
              </span>
              <Tag tone={TONE[data.status]}>{data.status}</Tag>
            </span>
          </div>
          {data.status === 'DEAD' ? (
            <p
              role="alert"
              className="m-0 rounded-[10px] bg-danger-soft px-3 py-2 text-xs leading-4 font-bold text-danger-text"
            >
              {t('admin.fragment.deadHint')}
            </p>
          ) : null}
          <KeyValues
            rows={[
              {
                key: 'ok',
                label: t('admin.fragment.lastOk'),
                value: data.lastOkAt ? formatDateTime(data.lastOkAt) : '—',
              },
              {
                key: 'dead',
                label: t('admin.fragment.deadAt'),
                value: data.deadAt ? formatDateTime(data.deadAt) : '—',
              },
              {
                key: 'updated',
                label: t('admin.fragment.updated'),
                value: data.updatedAt ? formatDateTime(data.updatedAt) : '—',
              },
            ]}
          />
          <PendingActions labels={[t('admin.fragment.refresh')]} />
        </Panel>
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {query.isError ? (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <div role="status" aria-label={t('admin.states.loading')} className="px-3.5">
              <Skeleton className="h-40 rounded-md" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function FragmentPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="infra.read" title={t('admin.nav.fragment')}>
      <Fragment />
    </SectionGate>
  );
}
