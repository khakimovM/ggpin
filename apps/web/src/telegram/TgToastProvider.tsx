'use client';

import { ToastProvider } from '@repo/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Toasts of the Mini App: at the top, clear of Telegram's native MainButton. */
export function TgToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('common');
  return (
    <ToastProvider placement="top" closeLabel={t('close')}>
      {children}
    </ToastProvider>
  );
}
