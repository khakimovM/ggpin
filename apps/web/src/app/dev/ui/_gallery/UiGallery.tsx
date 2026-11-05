'use client';

import { ThemeProvider, ToastProvider } from '@repo/ui';
import { useEffect, useState } from 'react';
import { ActionsSection } from './ActionsSection';
import { ContainersSection } from './ContainersSection';
import { FoundationsSection } from './FoundationsSection';
import { GalleryToolbar } from './GalleryToolbar';
import { InputsSection } from './InputsSection';
import { SAMPLES, type GalleryLang } from './samples';
import { SelectionSection } from './SelectionSection';
import { StatesSection } from './StatesSection';

// Every @repo/ui component in every state, in the active theme and sample language.
export function UiGallery() {
  const [lang, setLang] = useState<GalleryLang>('uz');
  const s = SAMPLES[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <ThemeProvider variant="web">
      <ToastProvider closeLabel={s.close} placement="bottom-end">
        <GalleryToolbar lang={lang} onLangChange={setLang} />
        <main className="mx-auto flex max-w-[1200px] flex-col gap-16 px-4 py-10 md:px-8">
          <FoundationsSection lang={lang} s={s} />
          <ActionsSection lang={lang} s={s} />
          <InputsSection lang={lang} s={s} />
          <SelectionSection lang={lang} s={s} />
          <ContainersSection lang={lang} s={s} />
          <StatesSection lang={lang} s={s} />
        </main>
      </ToastProvider>
    </ThemeProvider>
  );
}
