'use client';

import type { RecipientWarning } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Crown, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Messages } from '../../i18n/messages';

type WarningKey = keyof Messages['warnings'];

// One entry per key of the `warnings` catalog section, so a new key there does not compile until
// it has its icon here. A warning whose `message` is not a key of that section (a newer server,
// a typo) is not shown at all: the visitor never sees a raw key, and a warning never blocks.
const ICONS: Record<WarningKey, LucideIcon> = {
  premiumExtends: Crown,
};

const PREFIX = 'warnings.';

function isWarningKey(key: string): key is WarningKey {
  return Object.hasOwn(ICONS, key);
}

function catalogKey(message: string): WarningKey | null {
  if (!message.startsWith(PREFIX)) return null;
  const key = message.slice(PREFIX.length);
  return isWarningKey(key) ? key : null;
}

/** The warnings the catalog knows, each once, in the server's order. */
export function knownWarningKeys(warnings: readonly RecipientWarning[]): WarningKey[] {
  const keys: WarningKey[] = [];
  for (const warning of warnings) {
    const key = catalogKey(warning.message);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface RecipientWarningsProps {
  warnings: readonly RecipientWarning[];
}

/**
 * Non-blocking remarks about a recipient the server accepted (`warnings[]` of
 * `POST /recipients/validate`), under the found and the confirmed person. Product.dc.html
 * `premHas`: a yellow status note with a crown, "the gift extends the term". It never disables
 * buying; a recipient who cannot get the product is a 422 and the `blocked` phase instead.
 */
export function RecipientWarnings({ warnings }: RecipientWarningsProps) {
  const t = useTranslations('warnings');
  const keys = knownWarningKeys(warnings);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((key) => (
        <div
          key={key}
          role="status"
          className="flex items-start gap-2.5 rounded-[14px] bg-warning-soft p-3 text-[13px] leading-[19px] font-bold text-warning-text"
        >
          <Icon icon={ICONS[key]} size={17} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">{t(key)}</span>
        </div>
      ))}
    </>
  );
}
