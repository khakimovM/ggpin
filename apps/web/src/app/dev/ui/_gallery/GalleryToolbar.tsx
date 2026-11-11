'use client';

import { Logo, SegmentedControl, Switch, useTheme, type ThemePreference } from '@repo/ui';
import { BRAND } from '@repo/shared';
import type { GalleryLang } from './samples';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

const LANG_OPTIONS = [
  { value: 'uz', label: 'UZ', ariaLabel: 'O‘zbekcha' },
  { value: 'ru', label: 'RU', ariaLabel: 'Русский' },
] as const;

// Sticky controls of the gallery: theme, sample language and the reduced-motion switch, which
// exercise ThemeProvider the same way the profile screen will.
export function GalleryToolbar({
  lang,
  onLangChange,
}: {
  lang: GalleryLang;
  onLangChange: (lang: GalleryLang) => void;
}) {
  const { preference, setPreference, reducedMotion, setReducedMotion } = useTheme();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 md:px-8">
        <div className="flex items-center gap-3">
          <Logo name={BRAND.name} size={32} />
          <h1 className="text-lg leading-6 font-extrabold">UI gallery</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <SegmentedControl
            size="sm"
            variant="neutral"
            ariaLabel="Theme"
            options={THEME_OPTIONS}
            value={preference}
            onValueChange={(next: ThemePreference) => setPreference(next)}
          />
          <SegmentedControl
            size="sm"
            variant="neutral"
            ariaLabel="Sample language"
            options={LANG_OPTIONS}
            value={lang}
            onValueChange={onLangChange}
          />
          <label className="flex items-center gap-2 text-[13px] font-bold">
            <Switch
              size="sm"
              checked={reducedMotion}
              onCheckedChange={setReducedMotion}
              label="Reduced motion"
            />
            Reduced motion
          </label>
        </div>
      </div>
    </header>
  );
}
