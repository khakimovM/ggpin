import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, UserX } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { getUser } from '../../lib/api/people';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { SectionGate } from '../common/SectionGate';
import { TEXT_LINK } from '../common/link-style';
import { UserSummary } from './UserSummary';
import { UserTabs } from './UserTabs';

function UserDetail({ userId }: { userId: string }) {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.users.detail(userId),
    queryFn: ({ signal }) => getUser(userId, signal),
  });
  const back = (
    <Link to="/users" className={`inline-flex items-center gap-1 self-start text-xs ${TEXT_LINK}`}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t('admin.nav.users')}
    </Link>
  );
  if (query.data) {
    return (
      <>
        {back}
        <UserSummary user={query.data} />
        <UserTabs userId={userId} />
      </>
    );
  }
  if (query.isError) {
    const missing = isApiError(query.error) && query.error.code === 'NOT_FOUND';
    return (
      <>
        {back}
        <div className="rounded-md border border-border bg-card py-6">
          {missing ? (
            <ListEmpty icon={UserX} title={t('admin.users.notFound')} />
          ) : (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          )}
        </div>
      </>
    );
  }
  return (
    <>
      {back}
      <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-3">
        <Skeleton className="h-[220px] rounded-md" />
        <Skeleton className="h-[320px] rounded-md" />
      </div>
    </>
  );
}

export function UserDetailPage() {
  const t = useTranslations();
  const { id = '' } = useParams();
  return (
    <SectionGate permission="users.read" title={t('admin.nav.users')}>
      <UserDetail key={id} userId={id} />
    </SectionGate>
  );
}
