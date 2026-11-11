import type { BankDirection } from '@repo/shared';

// Line markers (docs/05-PAYMENTS.md §5, rule 2). The exact code points could not be read from
// the screenshots, so every plausible variant is accepted (D-37 (18)); each one has a unit test.
// Markers are compared after normalisation, i.e. without U+FE0F.

export type FieldKind = 'CARD' | 'CHANNEL' | 'TIME' | 'BALANCE';
export type LineKind = 'DIRECTION' | FieldKind;

export const DIRECTION_MARKERS: ReadonlyArray<readonly [string, BankDirection]> = [
  ['\u2795', 'CREDIT'], // ➕ heavy plus
  ['+', 'CREDIT'],
  ['\u2796', 'DEBIT'], // ➖ heavy minus
  ['\u2212', 'DEBIT'], // − minus sign
  ['-', 'DEBIT'],
];

// Clock faces U+1F550 (one o'clock) .. U+1F567 (twelve-thirty).
const CLOCK_FACES = Array.from({ length: 0x1f567 - 0x1f550 + 1 }, (_, index) =>
  String.fromCodePoint(0x1f550 + index),
);

export const FIELD_MARKERS: ReadonlyArray<readonly [FieldKind, readonly string[]]> = [
  ['CARD', ['\u{1F4B3}']], // 💳
  ['CHANNEL', ['\u{1F4CD}', '\u{1F4CC}']], // 📍 📌
  ['TIME', [...CLOCK_FACES, '\u23F0', '\u{1F570}']], // 🕐..🕧 ⏰ 🕰
  ['BALANCE', ['\u{1F4B0}', '\u{1F4B4}', '\u{1F4B5}', '\u{1F4B6}', '\u{1F4B7}']], // 💰 💴 💵 💶 💷
];

/** Uzcard's first-line colour dot. A hint only: the sign of the amount line decides. */
export const TITLE_COLOR_MARKERS: ReadonlyArray<readonly [string, BankDirection]> = [
  ['\u{1F7E2}', 'CREDIT'], // 🟢
  ['\u{1F534}', 'DEBIT'], // 🔴
];

export interface DirectionLine {
  readonly kind: 'DIRECTION';
  readonly direction: BankDirection;
  readonly value: string;
}

export interface FieldLine {
  readonly kind: FieldKind;
  readonly value: string;
}

export type MarkedLine = DirectionLine | FieldLine;

/** A normalised line → its kind and the text after the marker, or null when it has no marker. */
export function classifyLine(line: string): MarkedLine | null {
  for (const [marker, direction] of DIRECTION_MARKERS) {
    if (line.startsWith(marker))
      return { kind: 'DIRECTION', direction, value: afterMarker(line, marker) };
  }
  for (const [kind, markers] of FIELD_MARKERS) {
    for (const marker of markers) {
      if (line.startsWith(marker)) return { kind, value: afterMarker(line, marker) };
    }
  }
  return null;
}

/** The direction a leading colour dot implies, or null. */
export function titleColor(line: string): BankDirection | null {
  for (const [marker, direction] of TITLE_COLOR_MARKERS) {
    if (line.startsWith(marker)) return direction;
  }
  return null;
}

function afterMarker(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}
