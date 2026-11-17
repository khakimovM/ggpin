import { Icon } from '@repo/ui';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { env } from '../../env';
import { useLogout } from '../../features/auth/use-admin-session';
import { useAdmin } from '../admin-context';
import { EnvBadge } from './EnvBadge';
import { RoleBadge } from './RoleBadge';
import { HEADER_BUTTON, ThemeToggle } from './ThemeToggle';

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase('uz'));
  return letters.join('');
}

/**
 * The 60px sticky header (Admin.dc.html): environment badge, theme switch, the signed-in admin and
 * sign-out. Global search and the alert bell arrive with their endpoints (S5).
 */
export function ShellHeader() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { admin } = useAdmin();
  const logout = useLogout();

  return (
    <header className="sticky top-0 z-20 flex h-[60px] flex-none items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-md lg:px-6">
      <EnvBadge label={env.VITE_ENV_LABEL} />
      <div className="ml-auto flex flex-none items-center gap-2">
        <ThemeToggle />
        <div
          className="flex h-[42px] items-center gap-2 rounded-control border-[1.5px] border-border bg-card py-0 pr-2.5 pl-1"
          aria-label={t('admin.shell.account', {
            name: admin.name,
            role: t(`admin.role.${admin.role}`),
          })}
          role="group"
        >
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-[9px] bg-primary-soft text-[11px] leading-none font-extrabold text-primary-soft-foreground"
          >
            {initialsOf(admin.name)}
          </span>
          <span aria-hidden="true" className="hidden flex-col gap-px lg:flex">
            <span className="max-w-40 truncate text-xs leading-[15px] font-extrabold">
              {admin.name}
            </span>
            <span className="text-[10px] leading-3 font-semibold text-foreground-muted tabular-nums">
              {admin.telegramIdMasked}
            </span>
          </span>
          <span aria-hidden="true">
            <RoleBadge role={admin.role} />
          </span>
        </div>
        <button
          type="button"
          className={HEADER_BUTTON}
          aria-label={t('admin.shell.logout')}
          disabled={logout.isPending}
          onClick={() =>
            logout.mutate(undefined, {
              onSettled: () => void navigate('/login', { replace: true }),
            })
          }
        >
          <Icon icon={LogOut} size={16} />
        </button>
      </div>
    </header>
  );
}
