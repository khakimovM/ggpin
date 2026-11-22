import type { AdminPermission } from '@repo/shared';
import type { ReactNode } from 'react';
import { useAdmin } from '../../app/admin-context';
import { rolesFor } from '../../app/sections';
import { ForbiddenState } from './ForbiddenState';
import { PageHeader } from './PageHeader';

interface Props {
  permission: AdminPermission;
  title: string;
  children: ReactNode;
}

/**
 * A screen behind its read permission: a role without it sees the title and the design's lock
 * state, and the screen (with its requests) is never mounted. Only a hint: the API answers 404.
 */
export function SectionGate({ permission, title, children }: Props) {
  const me = useAdmin();
  if (me.permissions.includes(permission)) return <>{children}</>;
  return (
    <>
      <PageHeader title={title} />
      <ForbiddenState allowed={rolesFor(permission)} role={me.admin.role} />
    </>
  );
}
