import { MAX_MESSAGE_LENGTH, normalizeLines } from '../normalize';
import { parseBankMessage } from '../parse-bank-message';
import { humoMessage, uzcardMessage } from './synthetic';

describe('normalizeLines', () => {
  it('drops U+FE0F so a marker matches with and without it', () => {
    expect(normalizeLines('\u{2795}\u{FE0F} A\n\u{1F4B3}\u{FE0F} B')).toEqual([
      '\u{2795} A',
      '\u{1F4B3} B',
    ]);
  });

  it('drops the text presentation selector U+FE0E too', () => {
    expect(normalizeLines('\u{2795}\u{FE0E} A\n\u{1F4B3}\u{FE0E} B')).toEqual([
      '\u{2795} A',
      '\u{1F4B3} B',
    ]);
  });

  it.each([
    ['NBSP U+00A0', 0xa0],
    ['en quad U+2000 (NFC → U+2002)', 0x2000],
    ['em quad U+2001 (NFC → U+2003)', 0x2001],
    ['en space U+2002', 0x2002],
    ['em space U+2003', 0x2003],
    ['three-per-em space U+2004', 0x2004],
    ['four-per-em space U+2005', 0x2005],
    ['six-per-em space U+2006', 0x2006],
    ['figure space U+2007', 0x2007],
    ['punctuation space U+2008', 0x2008],
    ['thin space U+2009', 0x2009],
    ['hair space U+200A', 0x200a],
    ['narrow NBSP U+202F', 0x202f],
    ['medium math space U+205F', 0x205f],
    ['ideographic space U+3000', 0x3000],
  ])('turns %s into a plain space', (_, codePoint) => {
    const space = String.fromCodePoint(codePoint);
    expect(normalizeLines(`20${space}341.00${space}UZS`)).toEqual(['20 341.00 UZS']);
  });

  it.each([
    ['NEL U+0085', 0x85],
    ['line separator U+2028', 0x2028],
    ['paragraph separator U+2029', 0x2029],
  ])('splits lines on %s', (_, codePoint) => {
    const separator = String.fromCodePoint(codePoint);
    expect(normalizeLines(`a${separator}b${separator}${separator}c`)).toEqual(['a', 'b', 'c']);
  });

  it('applies NFC (a decomposed letter compares equal to the composed one)', () => {
    expect(normalizeLines('\u{43F}\u{43E}\u{438}\u{306}')).toEqual(['\u{43F}\u{43E}\u{439}']);
  });

  it('splits on LF, CRLF and CR, trims, collapses spaces and drops blank lines', () => {
    expect(normalizeLines('  a  \r\n\r\n b\t\tc \r d\n\n   \n')).toEqual(['a', 'b c', 'd']);
  });

  it('returns no lines for blank text', () => {
    expect(normalizeLines('')).toEqual([]);
    expect(normalizeLines(' \n\t\n\u{FE0F}\u{FE0E}\u{A0}\u{3000}\u{2028}')).toEqual([]);
  });

  it('uses the Telegram message limit', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4096);
  });
});

// Review finding S5 #8, end to end: the new separators reach the parser as plain ones.
describe('normalisation inside a whole message', () => {
  it('a Humo message split by U+2028 parses like the LF one', () => {
    const lf = humoMessage();
    expect(parseBankMessage('HUMO_BOT', lf.split('\n').join('\u{2028}'))).toEqual(
      parseBankMessage('HUMO_BOT', lf),
    );
  });

  it('figure-space thousands and FE0E markers in an Uzcard message', () => {
    const plain = uzcardMessage();
    const odd = uzcardMessage({
      direction: '\u{2795}\u{FE0E} 20\u{2007}341.00\u{2007}UZS',
      balance: '\u{1F4B5}\u{FE0E} 987\u{3000}654.32 UZS',
    });
    expect(parseBankMessage('UZCARD_BOT', odd)).toEqual(parseBankMessage('UZCARD_BOT', plain));
    expect(parseBankMessage('UZCARD_BOT', odd)).toEqual(expect.objectContaining({ ok: true }));
  });
});
