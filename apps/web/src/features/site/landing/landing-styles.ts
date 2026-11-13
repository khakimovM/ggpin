import { cn } from '@repo/ui';
import { LINK_FOCUS } from '../shell/nav-config';

// Class fragments the landing sections share (Site.dc.html `page: landing`). The prototype sizes
// everything by its container width (`cqi`); the page is as wide as the window, so the same
// clamp() rules read `vw`.

/** The centred column every section uses: 1264 px, side padding 16..32 px. */
export const LANDING_CONTAINER = 'mx-auto w-full max-w-[1264px] px-[clamp(16px,2.5vw,32px)]';

/** Vertical padding of a section. */
export const LANDING_SECTION_Y = 'py-[clamp(48px,6vw,96px)]';

/**
 * Anchored sections keep their heading below the sticky header (64..72 px) when a nav link
 * scrolls to them.
 */
export const LANDING_ANCHOR = 'scroll-mt-[clamp(64px,5vw,72px)]';

export const LANDING_H2 =
  'm-0 text-[clamp(26px,2.6vw,38px)] leading-[1.15] font-extrabold tracking-[-.02em] text-balance';

export const LANDING_LEAD = 'm-0 text-base leading-6 font-medium text-foreground-secondary';

/**
 * The box of a landing button (size, padding, text) without its colours: the two buttons below add
 * theirs, and a placeholder that stands in for a button takes the box alone to take the same room.
 * Not buttonVariants(): it lives in a client module and cannot be called on the server. Labels may
 * wrap (Round 9 - Russian QA: no fixed height on a button), hence min-height and text-balance.
 */
export const LANDING_CTA_BOX =
  'flex min-h-14 items-center justify-center gap-2.5 rounded-tile px-4 py-2 text-center text-base leading-5 font-extrabold text-balance no-underline';

export const LANDING_CTA_PRIMARY = cn(
  LANDING_CTA_BOX,
  'bg-primary text-primary-foreground shadow-glow transition-[background-color,transform] duration-fast hover:bg-primary-hover hover:text-primary-foreground active:scale-[.98] active:duration-instant',
  LINK_FOCUS,
);

export const LANDING_CTA_SECONDARY = cn(
  LANDING_CTA_BOX,
  'border-[1.5px] border-border bg-card text-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground',
  LINK_FOCUS,
);

/** The product grid, shared by the live block and its skeleton so that the two line up. */
export const PRODUCT_GRID =
  'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(max(156px,18vw),1fr))] gap-[clamp(12px,1.4vw,20px)] p-0';
