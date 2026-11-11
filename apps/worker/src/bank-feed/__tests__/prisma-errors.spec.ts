import { isUniqueViolationOn } from '../prisma-errors';

// S9 n1: only the message key means "already stored". The adapter shape is the one recorded on
// ggpin_test (the ingest replay e2e proves it end to end); values here are synthetic.
const KEY = { index: 'BankMessage_senderId_tgMessageId_key', columns: ['senderId', 'tgMessageId'] };

const adapter = (constraint: object) => ({
  code: 'P2002',
  meta: { driverAdapterError: { cause: { constraint } } },
});

describe('isUniqueViolationOn', () => {
  it('the pg adapter naming the index is this key', () => {
    expect(isUniqueViolationOn(adapter({ index: KEY.index }), KEY)).toBe(true);
  });

  it('a column list naming exactly these columns is this key (quoted or not)', () => {
    expect(isUniqueViolationOn({ code: 'P2002', meta: { target: KEY.columns } }, KEY)).toBe(true);
    expect(isUniqueViolationOn(adapter({ fields: ['"tgMessageId"', '"senderId"'] }), KEY)).toBe(
      true,
    );
  });

  it('another index, other columns, no names, or not P2002: not this key', () => {
    expect(isUniqueViolationOn(adapter({ index: 'BankMessageText_pkey' }), KEY)).toBe(false);
    expect(isUniqueViolationOn(adapter({ fields: ['"id"'] }), KEY)).toBe(false);
    expect(isUniqueViolationOn({ code: 'P2002', meta: {} }, KEY)).toBe(false);
    expect(isUniqueViolationOn({ code: 'P2003', meta: { target: KEY.columns } }, KEY)).toBe(false);
    expect(isUniqueViolationOn(new Error('x'), KEY)).toBe(false);
  });
});
