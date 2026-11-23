import type { AdminCard, AdminPermission } from '@repo/shared';
import { Button, Icon } from '@repo/ui';
import { Archive, Gauge, Pause, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useAdminAction } from '../common/use-admin-action';
import { CardLimitDialog } from './CardLimitDialog';
import { CardPauseResumeDialog } from './CardPauseResumeDialog';
import { CardRetireDialog } from './CardRetireDialog';
import { cardLabel } from './card-text';

type Kind = 'cards.pause' | 'cards.resume' | 'cards.limit' | 'cards.retire';

const LOOK: Record<Kind, { icon: LucideIcon; label: 'pause' | 'resume' | 'limit' | 'retire' }> = {
  'cards.pause': { icon: Pause, label: 'pause' },
  'cards.resume': { icon: Play, label: 'resume' },
  'cards.limit': { icon: Gauge, label: 'limit' },
  'cards.retire': { icon: Archive, label: 'retire' },
};

/**
 * The OWNER's buttons on a receiving card (docs/04 cards): pause or resume (by the auto-credit
 * pause), limit and retire. A retired card has none; adding a card stays CLI-only (D-63 (6)).
 */
export function CardActions({ card }: { card: AdminCard }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [open, setOpen] = useState<Kind | null>(null);
  if (card.status === 'RETIRED') return null;
  const kinds: Kind[] = [
    card.autoCreditPaused ? 'cards.resume' : 'cards.pause',
    'cards.limit',
    'cards.retire',
  ];
  const visible = kinds.filter((kind) => act.can(kind satisfies AdminPermission));
  if (visible.length === 0) return null;
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <div
      role="group"
      aria-label={t('admin.payments.cards.actions.label', { card: cardLabel(card) })}
      className="flex flex-wrap gap-2 border-t border-border pt-3"
    >
      {visible.map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          className={kind === 'cards.retire' ? 'text-danger-text' : undefined}
          onClick={() => setOpen(kind)}
        >
          <Icon icon={LOOK[kind].icon} size={14} />
          {t(`admin.payments.cards.actions.${LOOK[kind].label}`)}
        </Button>
      ))}
      {open === 'cards.pause' || open === 'cards.resume' ? (
        <CardPauseResumeDialog kind={open} card={card} open onOpenChange={close} />
      ) : null}
      <CardLimitDialog card={card} open={open === 'cards.limit'} onOpenChange={close} />
      <CardRetireDialog card={card} open={open === 'cards.retire'} onOpenChange={close} />
    </div>
  );
}
