import { Icon } from '@repo/ui';
import { Hammer } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { ForbiddenState } from '../../features/common/ForbiddenState';
import { useAdmin } from '../admin-context';
import { rolesFor, type Section } from '../sections';

/**
 * One section of the panel. The screens themselves arrive in S5-S8; until then the page shows its
 * title and a placeholder, or the lock state when the role lacks the read permission.
 */
export function SectionPage({ section }: { section: Section }) {
  const t = useTranslations();
  const me = useAdmin();
  const allowed = me.permissions.includes(section.permission);
  return (
    <>
      <h1 className="m-0 text-[22px] leading-7 font-extrabold tracking-[-.01em]">
        {t(`admin.nav.${section.id}`)}
      </h1>
      {allowed ? (
        <section
          aria-labelledby="placeholder-title"
          className="flex flex-col items-center gap-2.5 rounded-md border border-border bg-card px-5 py-12 text-center"
        >
          <span className="grid size-14 place-items-center rounded-full bg-primary-soft text-primary-soft-foreground">
            <Icon icon={Hammer} size={24} />
          </span>
          <h2 id="placeholder-title" className="m-0 text-base leading-[22px] font-extrabold">
            {t('admin.states.placeholder.title')}
          </h2>
          <p className="m-0 text-[13px] leading-[18px] font-semibold text-foreground-secondary">
            {t('admin.states.placeholder.body')}
          </p>
        </section>
      ) : (
        <ForbiddenState allowed={rolesFor(section.permission)} role={me.admin.role} />
      )}
    </>
  );
}
