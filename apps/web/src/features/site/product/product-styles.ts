// Class fragments of the product page that differ from the landing's (Site.dc.html `page: product`
// sizes its headings and sections a little tighter than `page: landing`). The prototype sizes by
// its container width (`cqi`); the page is as wide as the window, so the same clamp() rules read `vw`.

/** The heading of a section: 24..34 px. */
export const PRODUCT_H2 =
  'm-0 text-[clamp(24px,2.4vw,34px)] leading-[1.2] font-extrabold tracking-[-.02em] text-balance';

/** Vertical padding of a section: 48..88 px. */
export const PRODUCT_SECTION_Y = 'py-[clamp(48px,6vw,88px)]';

// The blocks below are drawn twice: with the catalog's answer, and as the placeholder that stands in
// for it while the answer is on its way (product-skeletons.tsx). Both take their sizes from here, and
// the placeholder holds the same texts (invisible), so it takes the room of the answer at every
// width and in both languages and the page does not move when the answer arrives.

/** The cards under the picture (Narx / Minimal / Yetkazish). */
export const FACT_GRID = 'm-0 grid grid-cols-3 gap-2.5';
export const FACT_CARD =
  'flex min-w-0 flex-col gap-1 rounded-tile border border-border bg-card p-3.5';
export const FACT_LABEL = 'text-xs leading-4 font-semibold';
export const FACT_VALUE = 'm-0 text-[15px] leading-5 font-extrabold tabular-nums break-words';

/** The package list: the card, its heading row, the rows, the small print under them. */
export const PICKER_CARD = 'rounded-3xl border border-border bg-card p-2';
export const PICKER_HEAD =
  'flex justify-between px-3.5 pt-3 pb-2 text-xs leading-4 font-bold tracking-[.06em] uppercase';
export const PICKER_ROWS = 'flex flex-col gap-0.5';
export const PICKER_ROW =
  'flex min-h-14 w-full items-center gap-3 rounded-tile border-[1.5px] px-3.5';
export const PICKER_NOTE = 'm-0 px-3.5 pt-2.5 pb-2 text-[13px] leading-[18px] font-medium';

/** The buy button and the Telegram one: side by side, the second one under the first when narrow. */
export const PRODUCT_BUTTONS = 'flex flex-wrap gap-2.5';
/** The buy button grows into the row; it keeps 260 px before the Telegram one wraps. */
export const BUY_BUTTON_SIZE = 'flex-[1_1_260px]';
/** The Telegram button on top of the secondary landing button's box (its border included). */
export const TELEGRAM_BUTTON_SIZE = 'flex-none px-5 text-[15px]';
