import { EmptyState, ErrorState, Icon } from '@repo/ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';

interface ErrorProps {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

/** The error state of a list or card: one line and "Qayta urinish" (offline gets its own text). */
export function LoadError({ error, onRetry, retrying }: ErrorProps) {
  const t = useTranslations();
  return (
    <ErrorState
      framed={false}
      title={t('admin.states.loadFailed')}
      description={
        isApiError(error) && error.code === 'NETWORK' ? t('admin.states.network') : undefined
      }
      retryLabel={t('admin.states.retry')}
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

interface EmptyProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** The empty state of a list, inside its card (icon, one line, the call to action). */
export function ListEmpty({ icon, title, description, action }: EmptyProps) {
  return (
    <EmptyState
      framed={false}
      icon={<Icon icon={icon} size={24} />}
      title={title}
      description={description}
      action={action}
    />
  );
}
