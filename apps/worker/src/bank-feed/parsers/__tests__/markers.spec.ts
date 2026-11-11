import { classifyLine, titleColor } from '../markers';
import { parseBankMessage } from '../parse-bank-message';
import { SYN, humoMessage } from './synthetic';

// Code points listed independently of markers.ts (docs/05-PAYMENTS.md §5 rule 2, plan §2.4).
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);
const hex = (marker: string): string =>
  [...marker].map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(' ');

const DIRECTION: ReadonlyArray<readonly [string, 'CREDIT' | 'DEBIT']> = [
  [cp(0x2795), 'CREDIT'],
  ['+', 'CREDIT'],
  [cp(0x2796), 'DEBIT'],
  [cp(0x2212), 'DEBIT'],
  ['-', 'DEBIT'],
];
const CLOCKS = Array.from({ length: 0x1f567 - 0x1f550 + 1 }, (_, i) => cp(0x1f550 + i));
const TIME = [...CLOCKS, cp(0x23f0), cp(0x1f570)];
const CARD = [cp(0x1f4b3)];
const CHANNEL = [cp(0x1f4cd), cp(0x1f4cc)];
const BALANCE = [cp(0x1f4b0), cp(0x1f4b4), cp(0x1f4b5), cp(0x1f4b6), cp(0x1f4b7)];

// Each marker with U+FE0F, without it, and glued to its value without a space.
const SPELLINGS = (marker: string): ReadonlyArray<readonly [string, string]> => [
  ['plain', `${marker} `],
  ['FE0F', `${marker}\uFE0F `],
  ['no space', marker],
];

const ok = (direction: 'CREDIT' | 'DEBIT'): unknown =>
  expect.objectContaining({ ok: true, direction, amountTiyin: SYN.amountTiyin });

describe('line markers', () => {
  it('lists all 24 clock faces U+1F550..U+1F567', () => {
    expect(CLOCKS).toHaveLength(24);
  });

  describe.each(DIRECTION)('direction %s', (marker, direction) => {
    it.each(SPELLINGS(marker))('%s', (_, prefix) => {
      // A neutral title, so the title check cannot interfere with the DEBIT markers.
      const text = humoMessage({ title: null, direction: `${prefix}${SYN.humoAmount}` });
      expect(parseBankMessage('HUMO_BOT', text)).toEqual(ok(direction));
    });
  });

  const fieldCases: ReadonlyArray<
    readonly [string, readonly string[], (prefix: string) => string]
  > = [
    ['card', CARD, (p) => humoMessage({ card: `${p}${SYN.humoCard}` })],
    ['channel', CHANNEL, (p) => humoMessage({ channel: `${p}${SYN.humoChannel}` })],
    ['time', TIME, (p) => humoMessage({ time: `${p}${SYN.humoTime}` })],
    ['balance', BALANCE, (p) => humoMessage({ balance: `${p}${SYN.humoBalance}` })],
  ];

  describe.each(fieldCases)('%s', (_, markers, build) => {
    for (const marker of markers) {
      it.each(SPELLINGS(marker))(`${hex(marker)} %s`, (__, prefix) => {
        expect(parseBankMessage('HUMO_BOT', build(prefix))).toEqual(ok('CREDIT'));
      });
    }
  });

  it.each([
    ['U+1F54F before the clock range', cp(0x1f54f)],
    ['U+1F568 after the clock range', cp(0x1f568)],
    ['U+1F4B8 money with wings', cp(0x1f4b8)],
    ['U+1F4B2 heavy dollar sign', cp(0x1f4b2)],
  ])('a near-miss code point is not a marker: %s', (_, marker) => {
    expect(classifyLine(`${marker} ${SYN.humoBalance}`)).toBeNull();
    expect(
      parseBankMessage('HUMO_BOT', humoMessage({ balance: `${marker} ${SYN.humoBalance}` })),
    ).toEqual({
      ok: false,
      reason: 'UNEXPECTED_LINE',
    });
  });

  it('classifies a line by its leading marker only', () => {
    expect(classifyLine(`\u2795 ${SYN.humoAmount}`)).toEqual({
      kind: 'DIRECTION',
      direction: 'CREDIT',
      value: SYN.humoAmount,
    });
    expect(classifyLine(`\u{1F4B3} ${SYN.uzcardCard}`)).toEqual({
      kind: 'CARD',
      value: SYN.uzcardCard,
    });
    // A marker in the middle of a line does not count.
    expect(classifyLine(`TEST \u{1F4B3} ${SYN.uzcardCard}`)).toBeNull();
  });

  it('reads the Uzcard colour dot of the title', () => {
    expect(titleColor('\u{1F7E2} Perevod na kartu')).toBe('CREDIT');
    expect(titleColor('\u{1F534} Pokupka')).toBe('DEBIT');
    expect(titleColor('Pokupka')).toBeNull();
  });
});
