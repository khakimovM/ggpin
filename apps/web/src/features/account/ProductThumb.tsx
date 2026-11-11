import { Icon, cn } from '@repo/ui';
import { Crown, Image as ImageIcon, Star, type LucideIcon } from 'lucide-react';

interface Look {
  icon: LucideIcon;
  tone: string;
}

// Account.dc.html `PI`: Stars and Premium have their own soft colours; every other product is a
// neutral picture slot until the API sends product pictures (the order DTO has none yet).
const LOOKS: Record<string, Look> = {
  'telegram-stars': { icon: Star, tone: 'bg-star-soft text-star' },
  'telegram-premium': { icon: Crown, tone: 'bg-premium-soft text-premium' },
};
const FALLBACK: Look = { icon: ImageIcon, tone: 'bg-muted text-foreground-muted' };

export function ProductThumb({
  slug,
  className,
}: {
  slug: string;
  /** Size and radius: 44 px / rounded-xl in lists, 36 px / rounded-[10px] in the table. */
  className?: string;
}) {
  const look = LOOKS[slug] ?? FALLBACK;
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-11 shrink-0 place-items-center rounded-xl', look.tone, className)}
    >
      <Icon icon={look.icon} size={19} />
    </span>
  );
}
