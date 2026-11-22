import { Button } from '@repo/ui';
import { useTranslations } from 'use-intl';

/** The call to action of a filtered empty list: back to the unfiltered view. */
export function ClearFilters({ onClear }: { onClear: () => void }) {
  const t = useTranslations();
  return (
    <Button variant="outline" size="sm" onClick={onClear}>
      {t('admin.list.clearFilters')}
    </Button>
  );
}
