import type { BankFeedSource } from '@repo/shared';
import { parseBankMessage } from '../parse-bank-message';
import { SYN, humoMessage, uzcardMessage } from './synthetic';

const PLUS = '\u{2795}';
const MINUS = '\u{2796}';
const BELL = '\u{1F514}';
const SIGN = { CREDIT: PLUS, DEBIT: MINUS } as const;
const OPPOSITE = { CREDIT: 'DEBIT', DEBIT: 'CREDIT' } as const;
const conflict = { ok: false, reason: 'DIRECTION_CONFLICT' };

/** A message from the given bot (its own amount and card shape) with this title and sign. */
function message(source: BankFeedSource, title: string, sign: string): string {
  return source === 'HUMO_BOT'
    ? humoMessage({ title, direction: `${sign} ${SYN.humoAmount}` })
    : uzcardMessage({ title, direction: `${sign} ${SYN.uzcardAmount}` });
}

describe('title against direction', () => {
  it.each([
    ["Humo To'ldirish with a minus", 'HUMO_BOT', `${BELL} To'ldirish`, MINUS],
    ["Humo To'lov with a plus", 'HUMO_BOT', `${BELL} To'lov`, PLUS],
    ['Humo U+2018 apostrophe', 'HUMO_BOT', `${BELL} To\u{2018}ldirish`, MINUS],
    ['Uzcard green dot with a minus', 'UZCARD_BOT', '\u{1F7E2} Perevod na kartu', MINUS],
    ['Uzcard red dot with a plus', 'UZCARD_BOT', '\u{1F534} Pokupka', PLUS],
    ['Uzcard red dot, unknown title, plus', 'UZCARD_BOT', '\u{1F534} TEST', PLUS],
    ['Uzcard green dot but Pokupka, minus', 'UZCARD_BOT', '\u{1F7E2} Pokupka', MINUS],
    ['Uzcard no dot, E-Com oplata, plus', 'UZCARD_BOT', 'E-Com oplata', PLUS],
  ] as const)('DIRECTION_CONFLICT: %s', (_, source, title, sign) => {
    expect(parseBankMessage(source, message(source, title, sign))).toEqual(conflict);
  });

  // Review finding S5 #2: punctuation, quotes, odd spaces or apostrophes around a known title
  // must not hide it. Each spelling is refused against the opposite sign and passes (with the
  // hint) with its own sign.
  describe.each([
    ['colon', 'HUMO_BOT', "To'lov:", 'DEBIT'],
    ['exclamation mark', 'HUMO_BOT', "To'lov!", 'DEBIT'],
    ['full stop', 'HUMO_BOT', "To'lov.", 'DEBIT'],
    ['double quotes', 'HUMO_BOT', '"To\'lov"', 'DEBIT'],
    ['guillemets', 'HUMO_BOT', "\u{AB}To'ldirish\u{BB}", 'CREDIT'],
    ['zero-width space before (U+200B)', 'HUMO_BOT', "\u{200B}To'lov", 'DEBIT'],
    ['zero-width joiner inside (U+200D)', 'HUMO_BOT', "To\u{200D}'lov", 'DEBIT'],
    ['modifier prime U+02B9', 'HUMO_BOT', 'To\u{2B9}lov', 'DEBIT'],
    ['prime U+2032', 'HUMO_BOT', 'To\u{2032}lov', 'DEBIT'],
    ['fullwidth apostrophe U+FF07', 'HUMO_BOT', 'To\u{FF07}ldirish', 'CREDIT'],
    ['upper case', 'HUMO_BOT', "TO'LOV", 'DEBIT'],
    ['Russian with colon', 'HUMO_BOT', '\u{41E}\u{43F}\u{43B}\u{430}\u{442}\u{430}:', 'DEBIT'],
    ['Uzcard with colon', 'UZCARD_BOT', 'Pokupka:', 'DEBIT'],
    ['Uzcard with exclamation mark', 'UZCARD_BOT', 'E-Com oplata!', 'DEBIT'],
    ['Uzcard in quotes', 'UZCARD_BOT', '"Perevod na kartu"', 'CREDIT'],
    // Re-review S5 #2a / #2b.
    ['soft hyphen inside (U+00AD)', 'HUMO_BOT', "To'l\u{AD}ov", 'DEBIT'],
    ['soft hyphen inside, credit title', 'HUMO_BOT', "To'l\u{AD}dirish", 'CREDIT'],
    ['hyphen U+2010', 'UZCARD_BOT', 'E\u{2010}Com oplata', 'DEBIT'],
    ['non-breaking hyphen U+2011', 'UZCARD_BOT', 'E\u{2011}Com oplata', 'DEBIT'],
    ['figure dash U+2012', 'UZCARD_BOT', 'E\u{2012}Com oplata', 'DEBIT'],
    ['en dash U+2013', 'UZCARD_BOT', 'E\u{2013}Com oplata', 'DEBIT'],
    ['em dash U+2014', 'UZCARD_BOT', 'E\u{2014}Com oplata', 'DEBIT'],
    ['horizontal bar U+2015', 'UZCARD_BOT', 'E\u{2015}Com oplata', 'DEBIT'],
    ['minus sign U+2212', 'UZCARD_BOT', 'E\u{2212}Com oplata', 'DEBIT'],
  ] as const)('%s', (_, source, title, direction) => {
    it('refused against the opposite sign', () => {
      const text = message(source, `${BELL} ${title}`, SIGN[OPPOSITE[direction]]);
      expect(parseBankMessage(source, text)).toEqual(conflict);
    });

    it('accepted with its own sign, with the hint, as a KNOWN title', () => {
      const text = message(source, `${BELL} ${title}`, SIGN[direction]);
      expect(parseBankMessage(source, text)).toEqual(
        expect.objectContaining({ ok: true, direction, titleHint: direction, titleKnown: true }),
      );
    });
  });

  // N1 / D-43 (1): a known title followed by more words still REFUSES the opposite sign (prefix
  // rule), but it is not the known title, so it is never credited automatically.
  describe.each([
    ['comma', 'HUMO_BOT', "To'lov, TEST", 'DEBIT'],
    ['ideographic space (U+3000)', 'HUMO_BOT', "To'lov\u{3000}TEST", 'DEBIT'],
    ['zero-width space after (U+200B)', 'HUMO_BOT', "To'lov\u{200B}TEST", 'DEBIT'],
    ['a word after the credit title', 'HUMO_BOT', "To'ldirish TEST", 'CREDIT'],
    ['Russian credit title with a word after', 'HUMO_BOT', 'Пополнение наличными', 'CREDIT'],
    ['a status in brackets', 'HUMO_BOT', "To'ldirish (bekor qilindi)", 'CREDIT'],
    ['a suffix after a dash', 'UZCARD_BOT', 'Perevod na kartu - otmena', 'CREDIT'],
    ['a second credit word', 'UZCARD_BOT', "Kartaga o'tkazma qaytarildi", 'CREDIT'],
  ] as const)('%s', (_, source, title, direction) => {
    it('refused against the opposite sign', () => {
      const text = message(source, `${BELL} ${title}`, SIGN[OPPOSITE[direction]]);
      expect(parseBankMessage(source, text)).toEqual(conflict);
    });

    it('with its own sign: the hint, but NOT a known title (TITLE_UNKNOWN later)', () => {
      const text = message(source, `${BELL} ${title}`, SIGN[direction]);
      expect(parseBankMessage(source, text)).toEqual(
        expect.objectContaining({ ok: true, direction, titleHint: direction, titleKnown: false }),
      );
    });
  });

  it.each([
    ['full stop', 'HUMO_BOT', "To'ldirish."],
    ['emoji after', 'HUMO_BOT', "To'ldirish ✅"],
    ['colour dot before, full stop after', 'UZCARD_BOT', '🟢 Perevod na kartu.'],
    ['several marks after', 'UZCARD_BOT', "Kartaga o'tkazma!!"],
  ] as const)('the exact title with %s is known', (_, source, title) => {
    expect(parseBankMessage(source, message(source, title, PLUS))).toEqual(
      expect.objectContaining({ ok: true, titleHint: 'CREDIT', titleKnown: true }),
    );
  });

  it.each([
    ['unknown title', `${BELL} TEST`],
    ['a longer word is not the known title', `${BELL} To'lovlar`],
    ['a digit continues the word', `${BELL} To'lov2`],
  ])('%s: accepted without a hint, not a known title', (_, title) => {
    expect(parseBankMessage('HUMO_BOT', message('HUMO_BOT', title, PLUS))).toEqual(
      expect.objectContaining({ ok: true, titleHint: null, titleKnown: false }),
    );
  });

  it('a colour dot gives a direction hint but is not a known title (D-43 (1))', () => {
    expect(parseBankMessage('UZCARD_BOT', message('UZCARD_BOT', '🟢 TEST', PLUS))).toEqual(
      expect.objectContaining({ ok: true, titleHint: 'CREDIT', titleKnown: false }),
    );
    expect(
      parseBankMessage('UZCARD_BOT', message('UZCARD_BOT', '🟢 Perevod na kartu', PLUS)),
    ).toEqual(expect.objectContaining({ ok: true, titleHint: 'CREDIT', titleKnown: true }));
  });

  it('the title list belongs to the bot: a Humo title means nothing to Uzcard and back', () => {
    expect(parseBankMessage('HUMO_BOT', message('HUMO_BOT', `${BELL} To'lov`, PLUS))).toEqual(
      conflict,
    );
    expect(parseBankMessage('UZCARD_BOT', message('UZCARD_BOT', `${BELL} To'lov`, PLUS))).toEqual(
      expect.objectContaining({ ok: true, titleHint: null }),
    );
    expect(parseBankMessage('UZCARD_BOT', message('UZCARD_BOT', 'Pokupka', PLUS))).toEqual(
      conflict,
    );
    expect(parseBankMessage('HUMO_BOT', message('HUMO_BOT', 'Pokupka', PLUS))).toEqual(
      expect.objectContaining({ ok: true, titleHint: null }),
    );
  });
});
