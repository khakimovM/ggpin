import { Button } from '@repo/ui';
import { useTranslations } from 'use-intl';

interface Props {
  /** Labels of the actions the design shows here; they are wired in S7. */
  labels: readonly string[];
}

/**
 * The action buttons of a detail screen, shown as in the design but disabled: the write
 * endpoints are connected in phase 9 S7. The note says so, so nobody waits for a click.
 */
export function PendingActions({ labels }: Props) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {labels.map((label) => (
        <Button key={label} variant="outline" size="sm" disabled>
          {label}
        </Button>
      ))}
      <span className="text-[11px] leading-4 font-semibold text-foreground-muted">
        {t('admin.list.actionsLater')}
      </span>
    </div>
  );
}
