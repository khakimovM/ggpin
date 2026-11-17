import { Icon, cn, FOCUS_RING, useTheme } from '@repo/ui';
import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'use-intl';

export const HEADER_BUTTON = cn(
  'grid size-[38px] flex-none place-items-center rounded-sm border-[1.5px] border-border bg-card text-foreground',
  'transition-colors duration-fast ease-standard hover:bg-muted',
  FOCUS_RING,
);

/** Light / dark switch of the header (38px, Admin.dc.html); the choice is remembered per browser. */
export function ThemeToggle() {
  const t = useTranslations();
  const { theme, setPreference } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className={HEADER_BUTTON}
      aria-label={dark ? t('admin.shell.themeToLight') : t('admin.shell.themeToDark')}
      onClick={() => setPreference(dark ? 'light' : 'dark')}
    >
      <Icon icon={dark ? Sun : Moon} size={16} />
    </button>
  );
}
