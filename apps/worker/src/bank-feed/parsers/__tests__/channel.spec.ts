import { parseBankMessage } from '../parse-bank-message';
import { SYN, humoMessage, uzcardMessage } from './synthetic';

const PIN = '\u{1F4CD}';
const humo = (channel: string | null) => parseBankMessage('HUMO_BOT', humoMessage({ channel }));
const refused = (reason: string) => ({ ok: false, reason });
const accepted = (channel: string | null): unknown =>
  expect.objectContaining({ ok: true, channel });

describe('channel', () => {
  it('is optional', () => {
    expect(humo(null)).toEqual(accepted(null));
  });

  it('a marker with no text is no channel', () => {
    expect(humo(PIN)).toEqual(accepted(null));
  });

  it('continuation lines are joined with one space', () => {
    const channel = `${PIN} TEST BANK\nP2P,\nUZ`;
    expect(parseBankMessage('UZCARD_BOT', uzcardMessage({ channel }))).toEqual(
      accepted(SYN.uzcardChannel),
    );
  });

  it('200 characters are accepted, 201 are CHANNEL_TOO_LONG', () => {
    const exact = 'T'.repeat(200);
    expect(humo(`${PIN} ${exact}`)).toEqual(accepted(exact));
    expect(humo(`${PIN} ${exact}T`)).toEqual(refused('CHANNEL_TOO_LONG'));
  });

  it('the length limit counts the joined continuation lines', () => {
    const channel = `${PIN} ${'T'.repeat(100)}\n${'T'.repeat(100)}`;
    expect(parseBankMessage('UZCARD_BOT', uzcardMessage({ channel }))).toEqual(
      refused('CHANNEL_TOO_LONG'),
    );
  });

  // Review finding S5 #3: control and bidi characters would be shown to the owner in a
  // terminal (review:show); the message is refused instead of being stored with them.
  it.each([
    ['NUL', '\u{0}'],
    ['ESC', '\u{1B}'],
    ['BEL', '\u{7}'],
    ['DEL', '\u{7F}'],
    ['C1 CSI', '\u{9B}'],
    ['LRE U+202A', '\u{202A}'],
    ['RLE U+202B', '\u{202B}'],
    ['PDF U+202C', '\u{202C}'],
    ['LRO U+202D', '\u{202D}'],
    ['RLO U+202E', '\u{202E}'],
    ['LRI U+2066', '\u{2066}'],
    ['RLI U+2067', '\u{2067}'],
    ['FSI U+2068', '\u{2068}'],
    ['PDI U+2069', '\u{2069}'],
    ['LRM U+200E', '\u{200E}'],
    ['RLM U+200F', '\u{200F}'],
    ['ALM U+061C', '\u{61C}'],
    // Re-review S5 #3a: lone surrogates, tag characters, invisible format characters.
    ['lone high surrogate', '\u{D800}'],
    ['lone low surrogate', '\u{DC00}'],
    ['tag U+E0000', '\u{E0000}'],
    ['tag latin A U+E0041', '\u{E0041}'],
    ['cancel tag U+E007F', '\u{E007F}'],
    ['soft hyphen U+00AD', '\u{AD}'],
    ['zero-width space U+200B', '\u{200B}'],
    ['word joiner U+2060', '\u{2060}'],
    ['BOM U+FEFF', '\u{FEFF}'],
    ['interlinear anchor U+FFF9', '\u{FFF9}'],
    ['interlinear separator U+FFFA', '\u{FFFA}'],
    ['interlinear terminator U+FFFB', '\u{FFFB}'],
  ])('CHANNEL_FORMAT: %s', (_, character) => {
    expect(humo(`${PIN} TEST${character}P2P`)).toEqual(refused('CHANNEL_FORMAT'));
  });

  it('CHANNEL_FORMAT also in a continuation line, and before the length check', () => {
    const channel = `${PIN} TEST BANK\nP2P\u{1B}[2J`;
    expect(parseBankMessage('UZCARD_BOT', uzcardMessage({ channel }))).toEqual(
      refused('CHANNEL_FORMAT'),
    );
    expect(humo(`${PIN} ${'T'.repeat(250)}\u{202E}`)).toEqual(refused('CHANNEL_FORMAT'));
  });

  it('ordinary punctuation and Cyrillic are kept as they are', () => {
    const channel = 'TEST P2P>SHAHAR, \u{422}\u{415}\u{421}\u{422} (UZ) #1/2';
    expect(humo(`${PIN} ${channel}`)).toEqual(accepted(channel));
  });

  it('characters next to the refused ranges stay accepted', () => {
    // U+E0080 is outside the tag block, U+FFFC (object replacement) outside U+FFF9..U+FFFB,
    // and a complete surrogate pair (an emoji) is not a lone surrogate.
    for (const channel of ['TEST\u{E0080}P2P', 'TEST\u{FFFC}P2P', 'TEST \u{1F3E6} P2P']) {
      expect(humo(`${PIN} ${channel}`)).toEqual(accepted(channel));
    }
  });

  it('a tab is a plain space after normalisation, not a control character', () => {
    expect(humo(`${PIN} TEST\tP2P>SHAHAR`)).toEqual(accepted(SYN.humoChannel));
  });
});
