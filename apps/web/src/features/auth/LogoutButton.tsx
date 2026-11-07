'use client';

import { Button, Icon } from '@repo/ui';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LogoutNotice } from './LogoutNotice';
import { useLogout } from './use-logout';

/** "Chiqish" (Store.dc.html account menu). Loading while the request runs: the lock wait alone can take minutes. */
export function LogoutButton({ className }: { className?: string }) {
  const t = useTranslations('web.logout');
  const logout = useLogout();

  if (logout.isError) {
    return <LogoutNotice retrying={logout.isPending} onRetry={() => logout.mutate()} />;
  }
  return (
    <Button
      variant="outline"
      size="md"
      className={className}
      loading={logout.isPending}
      onClick={() => logout.mutate()}
    >
      {logout.isPending ? null : <Icon icon={LogOut} size={17} />}
      {logout.isPending ? t('pending') : t('action')}
    </Button>
  );
}
