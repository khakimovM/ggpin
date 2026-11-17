import { ADMIN_ROLES, type AdminRole } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Lock } from 'lucide-react';
import { useTranslations } from 'use-intl';

interface Props {
  /** Roles that may open the section (from the shared permission matrix). */
  allowed: readonly AdminRole[];
  /** The signed-in admin's role. */
  role: AdminRole;
}

/**
 * The lock state of a section the role may not open (AdminOps.dc.html, Q13). Only a hint: the API
 * answers the same 404 to such a role, whatever the panel shows.
 */
export function ForbiddenState({ allowed, role }: Props) {
  const t = useTranslations();
  // Matrix order (OWNER, OPERATOR, SUPPORT), joined the Uzbek way: "OWNER va OPERATOR".
  const roles = new Intl.ListFormat('uz', { type: 'conjunction' }).format(
    ADMIN_ROLES.filter((name) => allowed.includes(name)).map((name) => t(`admin.role.${name}`)),
  );
  return (
    <section
      aria-labelledby="forbidden-title"
      className="flex flex-col items-center gap-2.5 rounded-md border border-border bg-card px-5 py-12 text-center"
    >
      <span className="grid size-14 place-items-center rounded-full bg-muted text-foreground-muted">
        <Icon icon={Lock} size={24} />
      </span>
      <h2 id="forbidden-title" className="m-0 text-base leading-[22px] font-extrabold">
        {t('admin.states.forbidden.title', { roles })}
      </h2>
      <p className="m-0 text-[13px] leading-[18px] font-semibold text-foreground-secondary">
        {t('admin.states.forbidden.role', { role: t(`admin.role.${role}`) })}
      </p>
    </section>
  );
}
