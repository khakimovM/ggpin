import { parseBankMessage } from '../parsers/parse-bank-message';
import { checkCreditTitle, type StoredParse } from '../title-check';
import { uzcardText, type SyntheticMessage } from './synthetic-message';

const base: SyntheticMessage = {
  direction: 'CREDIT',
  amountTiyin: 2_034_100n,
  balanceAfterTiyin: 98_765_432n,
  last4: '1111',
  bankTxnAt: new Date('2030-01-01T07:00:00.000Z'),
};

function stored(text: string): StoredParse {
  const parsed = parseBankMessage('UZCARD_BOT', text);
  if (!parsed.ok) throw new Error(`synthetic text did not parse: ${parsed.reason}`);
  return { source: 'UZCARD_BOT', ...parsed };
}

describe('checkCreditTitle (D-43 (1))', () => {
  it('a known title is creditable', () => {
    const text = uzcardText(base);
    expect(checkCreditTitle(stored(text), text)).toEqual({ ok: true });
  });

  it('the Uzcard colour dot alone is NOT a known title (D-43 (1)): TITLE_UNKNOWN', () => {
    const text = uzcardText({ ...base, title: '🟢 TEST' });
    expect(checkCreditTitle(stored(text), text)).toEqual({ ok: false, note: 'TITLE_UNKNOWN' });
  });

  it.each([
    ['an unknown title', 'Uvedomlenie TEST'],
    ['no title line', null],
  ])('%s is TITLE_UNKNOWN (never auto-credited)', (_name, title) => {
    const text = uzcardText({ ...base, title });
    expect(checkCreditTitle(stored(text), text)).toEqual({ ok: false, note: 'TITLE_UNKNOWN' });
  });

  it('a re-parse that differs from the stored fields is REPARSE_MISMATCH', () => {
    const text = uzcardText(base);
    const tampered = { ...stored(text), amountTiyin: 2_034_200n };
    expect(checkCreditTitle(tampered, text)).toEqual({ ok: false, note: 'REPARSE_MISMATCH' });
    expect(checkCreditTitle(stored(text), 'garbage')).toEqual({
      ok: false,
      note: 'REPARSE_MISMATCH',
    });
  });

  it('a purged text is TEXT_MISSING', () => {
    expect(checkCreditTitle(stored(uzcardText(base)), null)).toEqual({
      ok: false,
      note: 'TEXT_MISSING',
    });
  });
});
