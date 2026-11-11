'use client';

import { SegmentedControl, useTheme } from '@repo/ui';
import { useTranslations } from 'next-intl';

/** Avto / Yorug‘ / Qorong‘i (Store.dc.html `themeOpts`); the ThemeProvider remembers the choice. */
export function ThemePicker() {
  const t = useTranslations('account.profile.appearance.theme');
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl
      variant="neutral"
      ariaLabel={t('label')}
      value={preference}
      onValueChange={setPreference}
      className="max-w-none"
      options={[
        { value: 'system', label: t('system') },
        { value: 'light', label: t('light') },
        { value: 'dark', label: t('dark') },
      ]}
    />
  );
}
