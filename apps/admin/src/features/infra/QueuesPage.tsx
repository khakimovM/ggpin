import type { AdminInfraQueuesResponse } from '@repo/shared';
import { Skeleton, cn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listQueues } from '../../lib/api/reads';
import { formatCount } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';

type Queue = AdminInfraQueuesResponse[number];

function QueueCard({ queue }: { queue: Queue }) {
  const t = useTranslations();
  const figures = [
    ['waiting', queue.waiting, 'text-foreground'],
    ['active', queue.active, 'text-info-text'],
    ['delayed', queue.delayed, 'text-foreground-secondary'],
    ['failed', queue.failed, queue.failed > 0 ? 'text-danger-text' : 'text-foreground'],
  ] as const;
  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <h2 className="m-0 min-w-0 truncate font-mono text-[13px] leading-[18px] font-bold">
          {queue.name}
        </h2>
        <span className="ml-auto flex gap-1">
          {queue.paused ? <Tag tone="warn">{t('admin.queues.paused')}</Tag> : null}
          <Tag tone={queue.failed > 0 ? 'bad' : 'ok'}>
            {t(queue.failed > 0 ? 'admin.queues.hasFailed' : 'admin.queues.healthy')}
          </Tag>
        </span>
      </div>
      <dl className="m-0 grid grid-cols-4 gap-2">
        {figures.map(([id, value, tone]) => (
          <div key={id} className="flex flex-col gap-0.5 rounded-[10px] bg-surface px-2.5 py-2">
            <dt className="text-[10px] leading-3 font-bold text-foreground-muted">
              {t(`admin.queues.${id}`)}
            </dt>
            <dd className={cn('m-0 text-base leading-5 font-extrabold tabular-nums', tone)}>
              {formatCount(value)}
            </dd>
          </div>
        ))}
      </dl>
      {queue.retryable && queue.failed > 0 ? (
        <p className="m-0 text-[11px] leading-[14px] font-semibold text-foreground-muted">
          {t('admin.queues.retryLater')}
        </p>
      ) : null}
    </article>
  );
}

function Queues() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.infra.queues(),
    queryFn: ({ signal }) => listQueues(signal),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title={t('admin.nav.queues')} sub={t('admin.queues.sub')} />
      {query.data && query.data.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {query.data.map((queue) => (
            <QueueCard key={queue.name} queue={queue} />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {query.data ? (
            <ListEmpty icon={Layers} title={t('admin.queues.empty')} />
          ) : query.isError ? (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <div
              role="status"
              aria-label={t('admin.states.loading')}
              className="grid gap-3 px-3.5 lg:grid-cols-2"
            >
              <Skeleton className="h-32 rounded-md" />
              <Skeleton className="h-32 rounded-md" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function QueuesPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="infra.read" title={t('admin.nav.queues')}>
      <Queues />
    </SectionGate>
  );
}
