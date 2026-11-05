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
