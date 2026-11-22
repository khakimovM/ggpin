import { FOCUS_RING, cn } from '@repo/ui';

/** The primary cell link of a table row (the keyboard path to the detail screen). */
export const ROW_LINK = cn(
  'rounded-xs font-extrabold text-foreground no-underline hover:underline',
  FOCUS_RING,
);

/** An inline link to another screen (primary soft colour, design "Ochish →"). */
export const TEXT_LINK = cn(
  'rounded-xs font-extrabold text-primary-soft-foreground no-underline hover:underline',
  FOCUS_RING,
);
