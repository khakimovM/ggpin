import { Button, EmptyState, Icon } from '@repo/ui';
import { MapPinOff } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';

export function NotFoundPage() {
  const t = useTranslations();
  return (
    <>
      <h1 className="sr-only">{t('admin.states.notFound.title')}</h1>
      <EmptyState
        icon={<Icon icon={MapPinOff} size={24} />}
        title={t('admin.states.notFound.title')}
        description={t('admin.states.notFound.body')}
        action={
          <Button asChild size="sm">
            <Link to="/">{t('admin.states.notFound.cta')}</Link>
          </Button>
        }
      />
    </>
  );
}
