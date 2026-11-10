// Class fragments shared by several components. Colours come from tokens only.

/** Keyboard focus ring: 2px background gap + 2px ring (design: 0 0 0 2px bg, 0 0 0 4px ring). */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Text field focus: border turns ring-coloured and gets a soft 3px halo. */
export const FIELD_FOCUS =
  'focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-primary-soft';

/**
 * Grows the touch target to at least 44 x 44 without changing the visual size: a transparent
 * pseudo-element centred on the control. Centred (not inset by a fixed amount) so it stays right
 * for any control height and for borders, which would shrink an inset-based box. The element
 * needs `relative`; inside an overflow-auto row leave 4px of padding for it to extend into.
 */
export const HIT_AREA_44 =
  "before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/**
 * Vertical-only 44 px hit area, for a control that sits on a pitch too tight for a wider one (the
 * promo dots, 24 px apart): a wider area would take the neighbour's taps. Mark the element
 * `data-hit="y"` so the QA spec holds it to 44 high and the desktop floor (24) wide. Needs `relative`.
 */
export const HIT_AREA_44_Y =
  "before:absolute before:top-1/2 before:left-0 before:h-11 before:w-full before:-translate-y-1/2 before:content-['']";

/**
 * Hit area of a text link or a small inline control, whose size comes from the context:
 * `--hit-min` is 44 px in a touch context (the Mini App, a viewport under 768 px, a coarse pointer)
 * and 24 px on a desktop (WCAG 2.2 AA 2.5.8); see globals.css. The drawn link does not change. The
 * element needs `relative` and must be a box (flex/grid item, `inline-block`), not a plain inline.
 */
export const HIT_AREA_LINK =
  "before:absolute before:top-1/2 before:left-1/2 before:h-[max(100%,var(--hit-min,44px))] before:w-[max(100%,var(--hit-min,44px))] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";
