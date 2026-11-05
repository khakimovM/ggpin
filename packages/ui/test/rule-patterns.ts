// Patterns behind the source rules of packages/ui (see rules.test.ts). Kept apart so the tests
// can also prove that each pattern flags what it must and lets the allowed forms through.

// Colours: hex, every CSS colour function (color-mix included), Tailwind arbitrary colour
// keywords and arbitrary properties, and inline style / SVG attributes with a literal colour.
export const RAW_COLOUR = new RegExp(
  [
    String.raw`#[0-9a-fA-F]{3,8}\b`,
    String.raw`\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(`,
    String.raw`\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|caret|accent)-\[(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|transparent|currentColor)\]`,
    // [color:...] [background-color:...] [fill:...] [stroke:...]
    String.raw`\[(?:color|background(?:-color)?|fill|stroke):`,
    // style={{ color: 'white' }} · fill="white" · backgroundColor: "red" (variables and keywords
    // that inherit are fine)
    String.raw`\b(?:color|backgroundColor|background|fill|stroke|borderColor)\s*[:=]\s*\{?\s*['"\`](?!var\(|currentColor|inherit|transparent|none|['"\`])`,
  ].join('|'),
);

const PALETTE_NAMES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

// The Tailwind default palette is removed from the theme; white and black are not tokens either.
export const DEFAULT_PALETTE = new RegExp(
  String.raw`\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|caret|accent|placeholder)-(?:(?:${PALETTE_NAMES})-(?:50|[1-9]00|950)|white|black)\b`,
);

// Any way to load the i18n layer: import, export-from, require and dynamic import all quote the
// id, with ' " or a backtick.
export const I18N_MODULE = /['"`](?:next-intl|@repo\/i18n)(?:\/[^'"`]*)?['"`]/;

export const RADIX_SCOPED = /['"`]@radix-ui\//;

// Radii: 6 10 14 20 24 28 are --radius-xs..2xl; 8 12 16 are --radius-badge/-control/-tile
// (theme.css). 3xl / 4xl and rem values are outside the design's radius scale altogether.
export const TOKEN_RADIUS = new RegExp(
  [
    String.raw`\brounded(?:-[a-z]+)?-\[(?:6|8|10|12|14|16|20|24|28)px\]`,
    String.raw`\brounded(?:-[a-z]+)?-(?:3xl|4xl)\b`,
    String.raw`\brounded(?:-[a-z]+)?-\[[\d.]+rem\]`,
  ].join('|'),
);
