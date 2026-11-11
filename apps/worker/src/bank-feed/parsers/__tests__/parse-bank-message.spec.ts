import { BANK_FEED_SOURCES } from '@repo/shared';
import { HUMO_PROFILE, parseHumoMessage } from '../humo.parser';
import { parseBankMessage } from '../parse-bank-message';
import { PARSER_VERSION } from '../parser-version';
import { UZCARD_PROFILE, parseUzcardMessage } from '../uzcard.parser';
import { SYN, humoMessage, uzcardMessage } from './synthetic';

describe('parseBankMessage', () => {
  it('has a parser for every bank-feed source', () => {
    for (const source of BANK_FEED_SOURCES) {
      expect(parseBankMessage(source, '')).toEqual({ ok: false, reason: 'EMPTY' });
    }
  });

  it('the source picks the parser: HUMO_BOT → Humo profile, UZCARD_BOT → Uzcard profile', () => {
    // The card shape differs per bank, so each message passes only its own bank's parser.
    const humoText = humoMessage();
    const uzcardText = uzcardMessage();
    expect(parseBankMessage('HUMO_BOT', humoText)).toEqual(parseHumoMessage(humoText));
    expect(parseBankMessage('HUMO_BOT', humoText)).toEqual(
      expect.objectContaining({ ok: true, last4: '0000' }),
    );
    expect(parseBankMessage('UZCARD_BOT', uzcardText)).toEqual(parseUzcardMessage(uzcardText));
    expect(parseBankMessage('UZCARD_BOT', uzcardText)).toEqual(
      expect.objectContaining({ ok: true, last4: '1111' }),
    );
    expect(parseBankMessage('UZCARD_BOT', humoText)).toEqual({ ok: false, reason: 'CARD_FORMAT' });
    expect(parseBankMessage('HUMO_BOT', uzcardText)).toEqual({ ok: false, reason: 'CARD_FORMAT' });
  });

  it('either bot may print either amount and date format (language-independent)', () => {
    const mixed = uzcardMessage({
      direction: `\u2795 ${SYN.humoAmount}`,
      time: `\u{1F550} ${SYN.humoTime}`,
      balance: `\u{1F4B5} ${SYN.humoBalance}`,
    });
    expect(parseBankMessage('UZCARD_BOT', mixed)).toEqual({
      ok: true,
      direction: 'CREDIT',
      amountTiyin: SYN.amountTiyin,
      balanceAfterTiyin: SYN.humoBalanceTiyin,
      last4: '1111',
      bankTxnAt: SYN.instant,
      channel: SYN.uzcardChannel,
      titleHint: 'CREDIT',
      titleKnown: true,
    });
  });

  it('a large amount stays exact through the whole parser', () => {
    const text = uzcardMessage({ direction: '\u2795 99 999 999.99 UZS' });
    expect(parseBankMessage('UZCARD_BOT', text)).toEqual(
      expect.objectContaining({ ok: true, amountTiyin: 9_999_999_999n }),
    );
  });

  it('every known title is a whole phrase with a direction', () => {
    for (const { text, direction } of [...HUMO_PROFILE.titles, ...UZCARD_PROFILE.titles]) {
      expect(text.trim()).toBe(text);
      expect(['CREDIT', 'DEBIT']).toContain(direction);
    }
  });

  it('PARSER_VERSION is a positive integer stored with every row', () => {
    expect(Number.isInteger(PARSER_VERSION)).toBe(true);
    expect(PARSER_VERSION).toBeGreaterThan(0);
  });
});
