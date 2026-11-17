import { BRAND } from '@repo/shared';
import { Logo, Sidebar, type SidebarGroup } from '@repo/ui';
import { Link, Outlet, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';
import { SECTION_GROUPS, sectionOf } from '../sections';
import { ShellHeader } from './ShellHeader';

/**
 * The signed-in frame (Admin.dc.html): sidebar (248px from 1024, a 64px rail below), sticky header
 * and the page. Every section is listed for every role; a section the role may not open shows the
 * lock state (Q13), so the menu does not reshuffle between roles.
 */
export function AppShell() {
  const t = useTranslations();
  const { pathname } = useLocation();
  const groups: SidebarGroup[] = SECTION_GROUPS.map((group) => ({
    id: group.id,
    title: t(`admin.nav.groups.${group.id}`),
    items: group.sections.map((section) => ({
      id: section.id,
      label: t(`admin.nav.${section.id}`),
      icon: section.icon,
      href: section.path,
    })),
  }));

  return (
    <div className="grid min-h-dvh grid-cols-[64px_minmax(0,1fr)] bg-background text-[13px] text-foreground lg:grid-cols-[248px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-primary px-3 py-2 font-bold text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('admin.shell.skipToContent')}
      </a>
      <Sidebar
        label={t('admin.shell.menu')}
        className="sticky top-0 h-dvh"
        currentId={sectionOf(pathname)?.id ?? null}
        groups={groups}
        header={
          <>
            <Logo variant="mark" size={30} name={BRAND.name} decorative />
            <span className="hidden font-display text-[17px] leading-none font-bold tracking-[-.04em] lg:inline">
              {BRAND.name}
            </span>
            <span className="ml-auto hidden h-5 items-center rounded-xs bg-muted px-1.5 text-[10px] leading-none font-extrabold tracking-[.04em] text-foreground-muted lg:inline-flex">
              {t('admin.shell.badge')}
            </span>
          </>
        }
        renderLink={({ href, children, ...rest }) => (
          <Link to={href} {...rest}>
            {children}
          </Link>
        )}
      />
      <div className="flex min-h-dvh min-w-0 flex-col">
        <ShellHeader />
        <main
          id="main"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col gap-4 px-4 pt-5 pb-10 focus:outline-none lg:px-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
