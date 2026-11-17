import type { AdminRole } from '@repo/shared';
import { cn } from '@repo/ui';
import { useTranslations } from 'use-intl';

const TONE: Record<AdminRole, string> = {
  OWNER: 'bg-primary text-primary-foreground',
  OPERATOR: 'bg-info-soft text-info-text',
  SUPPORT: 'bg-muted text-foreground-secondary',
};

export function RoleBadge({ role }: { role: AdminRole }) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center rounded-xs px-1.5 text-[10px] leading-none font-extrabold tracking-[.04em]',
        TONE[role],
      )}
    >
      {t(`admin.role.${role}`)}
    </span>
  );
}
