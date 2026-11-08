import {
  chainVerdict,
  classifyCandidates,
  LATE_STORED_AFTER_MS,
  isLatePayment,
  isLateForClosedRequest,
  isLateStored,
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

describe('isLateStored (D-47)', () => {
  const tgDate = new Date('2030-05-03T10:00:00.000Z');
  const storedAfter = (ms: number) => ({ tgDate, createdAt: new Date(tgDate.getTime() + ms) });

  it('is 10 minutes: more than the live poll and a short retry, far less than an outage', () => {
    expect(LATE_STORED_AFTER_MS).toBe(600_000);
  });

  it('on time up to and at the bound, late one millisecond after it', () => {
    expect(isLateStored(storedAfter(20_000))).toBe(false);
    expect(isLateStored(storedAfter(LATE_STORED_AFTER_MS))).toBe(false);
    expect(isLateStored(storedAfter(LATE_STORED_AFTER_MS + 1))).toBe(true);
  });
});

describe('isLateForClosedRequest (D-47, B1)', () => {
  const tgDate = new Date('2030-05-03T10:00:00.000Z');
  const late = { tgDate, createdAt: new Date(tgDate.getTime() + LATE_STORED_AFTER_MS + 1) };
  const onTime = { tgDate, createdAt: new Date(tgDate.getTime() + 20_000) };
  const at = (ms: number) => new Date(late.createdAt.getTime() + ms);

  it('late: an EXPIRED request, and a PENDING one already overdue when stored, are closed', () => {
    expect(isLateForClosedRequest(late, { status: 'EXPIRED', expiresAt: at(-1) })).toBe(true);
    expect(isLateForClosedRequest(late, { status: 'PENDING', expiresAt: at(-1) })).toBe(true);
    expect(isLateForClosedRequest(late, { status: 'PENDING', expiresAt: at(0) })).toBe(true);
  });

  it('late but still open when stored: not closed (credited)', () => {
    expect(isLateForClosedRequest(late, { status: 'PENDING', expiresAt: at(1) })).toBe(false);
  });

  it('stored on time: never this rule', () => {
    expect(isLateForClosedRequest(onTime, { status: 'EXPIRED', expiresAt: at(-60_000) })).toBe(
      false,
    );
  });
});
