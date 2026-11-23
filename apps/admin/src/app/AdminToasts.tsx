import { ToastProvider } from '@repo/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

/** The result toasts of the admin actions (bottom right, the web placement of the design system). */
export function AdminToasts({ children }: { children: ReactNode }) {
  const t = useTranslations();
  return <ToastProvider closeLabel={t('admin.dialogs.close')}>{children}</ToastProvider>;
}
