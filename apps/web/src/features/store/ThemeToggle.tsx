'use client';

import { Icon, useTheme } from '@repo/ui';
import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Light or dark, remembered (the ThemeProvider keeps the choice in localStorage). */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations('web.nav');
  const { theme, setPreference } = useTheme();
  return (
    <button
      type="button"
      aria-label={t('theme')}
      onClick={() => setPreference(theme === 'dark' ? 'light' : 'dark')}
      className={`grid size-11 place-items-center rounded-xl border-[1.5px] border-border bg-card text-foreground focus-visible:outline-2 focus-visible:outline-ring ${className ?? ''}`}
    >
      <Icon icon={theme === 'dark' ? Sun : Moon} size={18} />
    </button>
  );
}
