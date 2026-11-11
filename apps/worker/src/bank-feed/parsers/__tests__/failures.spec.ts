import { PARSE_FAILURE_REASONS, type ParseFailureReason } from '../parse-result';
import { parseBankMessage } from '../parse-bank-message';
import { SYN, humoMessage, seededRandom, uzcardMessage } from './synthetic';

const PLUS = '\u2795';
const MINUS = '\u2796';
const refused = (reason: ParseFailureReason) => ({ ok: false, reason });
const humo = (text: string) => parseBankMessage('HUMO_BOT', text);
const uzcard = (text: string) => parseBankMessage('UZCARD_BOT', text);

describe('unrecognised messages (never credited)', () => {
  it.each([
    ['empty text', ''],
    ['only blank lines', ' \n\r\n\t\n'],
    ['only invisible selectors and NBSP', '\uFE0F\u00A0\u202F'],
  ])('EMPTY: %s', (_, text) => {
    expect(humo(text)).toEqual(refused('EMPTY'));
  });

  it('TOO_LONG above the Telegram limit', () => {
    expect(humo(`${humoMessage()}\n${'x'.repeat(4096)}`)).toEqual(refused('TOO_LONG'));
  });

  it.each([1, 2, 3, 4, 5])(
    'random 4096-character text is UNRECOGNIZED with a reason (seed %i)',
    (seed) => {
      const random = seededRandom(seed);
      // Markers, digits, separators and letters, so the fuzz hits every line kind.
      const pool = [
        ...`${PLUS}${MINUS}+-\u2212\u{1F4B3}\u{1F4CD}\u{1F55B}\u{1F4B0}\u{1F7E2}0123456789.,: *UZSHUMOCARDab\n`,
      ];
      let text = '';
      while (text.length < 4096) text += pool[Math.floor(random() * pool.length)] ?? '';
      text = text.slice(0, 4096);
      expect(text).toHaveLength(4096);
      const result = humo(text);
      expect(result.ok).toBe(false);
      expect(PARSE_FAILURE_REASONS).toContain(result.ok ? 'none' : result.reason);
      expect(result.ok ? 'none' : result.reason).not.toBe('TOO_LONG');
    },
  );

  it('a lone title is MISSING_DIRECTION', () => {
    expect(humo("\u{1F514} To'ldirish")).toEqual(refused('MISSING_DIRECTION'));
  });

  describe('amount line', () => {
    it('two amount lines → DUPLICATE_DIRECTION', () => {
      const text = `${humoMessage()}\n${PLUS} ${SYN.humoAmount}`;
      expect(humo(text)).toEqual(refused('DUPLICATE_DIRECTION'));
    });

    it('a credit and a debit line → DUPLICATE_DIRECTION', () => {
      const text = `${humoMessage({ title: null })}\n${MINUS} ${SYN.humoAmount}`;
      expect(humo(text)).toEqual(refused('DUPLICATE_DIRECTION'));
    });

    it('an amount without a sign right after the title → UNEXPECTED_LINE', () => {
      expect(humo(humoMessage({ direction: SYN.humoAmount }))).toEqual(refused('UNEXPECTED_LINE'));
    });

    it('an amount without a sign after the channel is channel text, so the sign is MISSING', () => {
      const text = humoMessage({ direction: '' }).replace(
        `${SYN.humoChannel}\n`,
        `${SYN.humoChannel}\n${SYN.humoAmount}\n`,
      );
      expect(humo(text)).toEqual(refused('MISSING_DIRECTION'));
    });

    it.each([
      ['one decimal', '20.341,0 UZS'],
      ['three decimals', '20 341.000 UZS'],
      ['USD', '20 341.00 USD'],
      ['no currency', '20.341,00'],
      ['zero', '0,00 UZS'],
      ['signed twice', '-20 341.00 UZS'],
    ])('AMOUNT_FORMAT: %s', (_, amount) => {
      expect(humo(humoMessage({ direction: `${PLUS} ${amount}` }))).toEqual(
        refused('AMOUNT_FORMAT'),
      );
    });
  });

  it.each([
    ['card', { card: '' }, 'MISSING_CARD'],
    ['time', { time: '' }, 'MISSING_TIME'],
    ['balance', { balance: '' }, 'MISSING_BALANCE'],
  ] as const)('missing %s', (_, parts, reason) => {
    // An empty string leaves a blank line, which the normaliser drops.
    expect(humo(humoMessage(parts))).toEqual(refused(reason));
  });

  it.each([
    ['card', `\u{1F4B3} ${SYN.uzcardCard}`, 'DUPLICATE_CARD'],
    ['time', `\u23F0 ${SYN.humoTime}`, 'DUPLICATE_TIME'],
    ['balance', `\u{1F4B5} ${SYN.uzcardBalance}`, 'DUPLICATE_BALANCE'],
    ['channel', `\u{1F4CC} ${SYN.uzcardChannel}`, 'DUPLICATE_CHANNEL'],
  ] as const)('duplicate %s', (_, extra, reason) => {
    expect(humo(`${humoMessage()}\n${extra}`)).toEqual(refused(reason));
  });

  it.each([
    ['one decimal', '123.456,7 UZS'],
    ['USD', '123.456,78 USD'],
    ['negative', '-123.456,78 UZS'],
  ])('BALANCE_FORMAT: %s', (_, balance) => {
    expect(humo(humoMessage({ balance: `\u{1F4B0} ${balance}` }))).toEqual(
      refused('BALANCE_FORMAT'),
    );
  });

  it('a zero balance is a valid balance', () => {
    expect(humo(humoMessage({ balance: '\u{1F4B0} 0,00 UZS' }))).toEqual(
      expect.objectContaining({ ok: true, balanceAfterTiyin: 0n }),
    );
  });

  it('a non-existent date (31.02) → DATE', () => {
    expect(humo(humoMessage({ time: '\u{1F55B} 12:00 31.02.2030' }))).toEqual(refused('DATE'));
    expect(uzcard(uzcardMessage({ time: '\u{1F550} 31.02.30 12:00' }))).toEqual(refused('DATE'));
  });

  it('an unknown time shape → DATE_FORMAT', () => {
    expect(humo(humoMessage({ time: '\u{1F55B} 2030-01-01 12:00' }))).toEqual(
      refused('DATE_FORMAT'),
    );
  });

  it('a stray unmarked line after a field → UNEXPECTED_LINE', () => {
    expect(humo(`${humoMessage()}\nTEST`)).toEqual(refused('UNEXPECTED_LINE'));
  });

  it('reason codes carry no text, digits or card fragments', () => {
    for (const reason of PARSE_FAILURE_REASONS) expect(reason).toMatch(/^[A-Z_]+$/);
  });
});
