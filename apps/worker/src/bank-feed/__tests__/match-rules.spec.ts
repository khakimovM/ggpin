import {
  chainVerdict,
  classifyCandidates,
  isLatePayment,
  isPastCapacityHold,
  isTimeSkewed,
  latestMatchableCreatedAt,
} from '../match-rules';

describe('chainVerdict (docs/05 §6 step 4)', () => {
  const credit = { direction: 'CREDIT', amountTiyin: 500n, balanceAfterTiyin: 1_500n } as const;
  const debit = { direction: 'DEBIT', amountTiyin: 500n, balanceAfterTiyin: 500n } as const;

  it('the first message of a card is FIRST', () => {
    expect(chainVerdict(null, credit)).toBe('FIRST');
  });

  it('previous + credit / previous - debit = balance is OK', () => {
    expect(chainVerdict({ balanceAfterTiyin: 1_000n }, credit)).toBe('OK');
    expect(chainVerdict({ balanceAfterTiyin: 1_000n }, debit)).toBe('OK');
  });

  it('anything else is a BREAK (a missed or forged message)', () => {
    expect(chainVerdict({ balanceAfterTiyin: 999n }, credit)).toBe('BREAK');
    const wrongSign = { ...debit, balanceAfterTiyin: 1_500n };
    expect(chainVerdict({ balanceAfterTiyin: 1_000n }, wrongSign)).toBe('BREAK');
  });
});

describe('time rules', () => {
  const at = new Date('2030-01-01T07:00:00.000Z');

  it('skew is strictly beyond the allowed seconds, either way', () => {
    expect(isTimeSkewed(new Date(at.getTime() + 600_000), at, 600)).toBe(false);
    expect(isTimeSkewed(new Date(at.getTime() + 600_001), at, 600)).toBe(true);
    expect(isTimeSkewed(new Date(at.getTime() - 600_001), at, 600)).toBe(true);
  });

  it('an intent may be created at most 120 s after the money arrived', () => {
    expect(latestMatchableCreatedAt(at)).toEqual(new Date('2030-01-01T07:02:00.000Z'));
  });

  it('late = paid at or after the deadline; past the hold = after deadline + hold', () => {
    const intent = { expiresAt: at };
    expect(isLatePayment(intent, new Date(at.getTime() - 1))).toBe(false);
    expect(isLatePayment(intent, at)).toBe(true);
    expect(isPastCapacityHold(intent, new Date(at.getTime() + 3_600_000), 3_600)).toBe(false);
    expect(isPastCapacityHold(intent, new Date(at.getTime() + 3_600_001), 3_600)).toBe(true);
  });
});

describe('classifyCandidates (docs/05 §6 step 6 table)', () => {
  it('one PENDING or EXPIRED is credited', () => {
    expect(classifyCandidates([{ id: 'a', status: 'PENDING' }])).toEqual({
      kind: 'CREDIT',
      intentId: 'a',
    });
    expect(classifyCandidates([{ id: 'b', status: 'EXPIRED' }])).toEqual({
      kind: 'CREDIT',
      intentId: 'b',
    });
  });

  it('one CANCELLED goes to review, several are AMBIGUOUS, none is NONE', () => {
    expect(classifyCandidates([{ id: 'c', status: 'CANCELLED' }])).toEqual({
      kind: 'CANCELLED_LATE',
      intentId: 'c',
    });
    const two = [
      { id: 'a', status: 'PENDING' },
      { id: 'b', status: 'EXPIRED' },
    ] as const;
    expect(classifyCandidates(two)).toEqual({ kind: 'AMBIGUOUS' });
    expect(classifyCandidates([])).toEqual({ kind: 'NONE' });
    expect(classifyCandidates([{ id: 'p', status: 'PAID' }])).toEqual({ kind: 'NONE' });
  });
});
