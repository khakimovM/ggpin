import {
  chainBreaks,
  creditUnaccounted,
  debitsByCard,
  findingOf,
  firstParsedPerCard,
} from '../reconcile-checks';
import { EXAMPLE_IDS, type WindowMessage } from '../reconcile.repository';

// Synthetic rows only: amounts and balances are made up, no card digits anywhere.
const T0 = new Date('2030-05-01T10:00:00.000Z');
let seq = 0;

function msg(over: Partial<WindowMessage> = {}): WindowMessage {
  seq += 1;
  return {
    id: `cm3msg${String(seq).padStart(4, '0')}`,
    cardId: 'cm3cardA',
    tgMessageId: BigInt(seq),
    createdAt: T0,
    parseStatus: 'PARSED',
    direction: 'CREDIT',
    amountTiyin: 1_000_00n,
    balanceAfterTiyin: null,
    outcome: { outcome: 'CREDITED', payment: { amountTiyin: 1_000_00n } },
    reviews: [],
    ...over,
  };
}

describe('findingOf', () => {
  it('keeps the full count and at most EXAMPLE_IDS example ids', () => {
    const ids = Array.from({ length: EXAMPLE_IDS + 5 }, (_, i) => `id${String(i)}`);
    const finding = findingOf(ids);
    expect(finding.count).toBe(EXAMPLE_IDS + 5);
    expect(finding.ids).toEqual(ids.slice(0, EXAMPLE_IDS));
  });
});

// Settled: everything at T0; the settle bound is a minute later.
const SETTLED = new Date(T0.getTime() + 60_000);

describe('creditUnaccounted', () => {
  it('accepts CREDITED of the same amount, CARD_VERIFIED and REVIEW', () => {
    const rows = [
      msg(),
      msg({ cardId: 'cm3cardB', outcome: { outcome: 'CARD_VERIFIED', payment: null } }),
      msg({ cardId: 'cm3cardB', outcome: { outcome: 'REVIEW', payment: null } }),
      msg({ direction: 'DEBIT', outcome: { outcome: 'DEBIT_RECORDED', payment: null } }),
    ];
    expect(creditUnaccounted(rows, SETTLED)).toEqual({ count: 0, ids: [] });
  });

  it('names the card of a CREDIT without a decision, a wrong decision or another amount', () => {
    const rows = [
      msg({ cardId: 'cm3cardA', outcome: null }),
      msg({ cardId: 'cm3cardB', outcome: { outcome: 'DEBIT_RECORDED', payment: null } }),
      msg({ cardId: 'cm3cardC', outcome: { outcome: 'CREDITED', payment: { amountTiyin: 1n } } }),
      msg({ cardId: 'cm3cardD' }),
      msg({ cardId: null, outcome: null }),
    ];
    expect(creditUnaccounted(rows, SETTLED)).toEqual({
      count: 3,
      ids: ['cm3cardA', 'cm3cardB', 'cm3cardC'],
    });
  });

  it('skips an undecided CREDIT stored after the settle bound: its job may be running', () => {
    const fresh = msg({ outcome: null, createdAt: SETTLED });
    expect(creditUnaccounted([fresh], SETTLED)).toEqual({ count: 0, ids: [] });
    const old = msg({ outcome: null, createdAt: new Date(SETTLED.getTime() - 1) });
    expect(creditUnaccounted([fresh, old], SETTLED)).toEqual({ count: 1, ids: ['cm3cardA'] });
  });
});

describe('chainBreaks', () => {
  it('passes a whole chain linked to the balance before the window', () => {
    const rows = [
      msg({ amountTiyin: 500n, balanceAfterTiyin: 1_500n }),
      msg({ direction: 'DEBIT', amountTiyin: 200n, balanceAfterTiyin: 1_300n }),
    ];
    expect(chainBreaks(rows, new Map([['cm3cardA', 1_000n]]))).toEqual({
      breaks: { count: 0, ids: [] },
      reviewed: 0,
    });
  });

  it('reports the message after a gap, per card, and the first link of the window', () => {
    const first = msg({ amountTiyin: 500n, balanceAfterTiyin: 1_600n }); // expected 1 500
    const ok = msg({ amountTiyin: 100n, balanceAfterTiyin: 1_700n });
    const gap = msg({ amountTiyin: 100n, balanceAfterTiyin: 9_999n });
    const otherCard = msg({ cardId: 'cm3cardB', amountTiyin: 1n, balanceAfterTiyin: 5n });
    const links = new Map<string, bigint | null>([
      ['cm3cardA', 1_000n],
      ['cm3cardB', null],
    ]);
    expect(chainBreaks([first, ok, gap, otherCard], links).breaks).toEqual({
      count: 2,
      ids: [first.id, gap.id],
    });
  });

  it('a gap whose CHAIN_BREAK review is RESOLVED (any resolution) is reviewed, not a mismatch', () => {
    const accepted = msg({
      amountTiyin: 1n,
      balanceAfterTiyin: 7_777n,
      reviews: [{ kind: 'CHAIN_BREAK', status: 'RESOLVED' }],
    });
    const ignored = msg({
      amountTiyin: 1n,
      balanceAfterTiyin: 8_888n,
      reviews: [{ kind: 'CHAIN_BREAK', status: 'RESOLVED' }],
    });
    const open = msg({
      amountTiyin: 1n,
      balanceAfterTiyin: 1n,
      reviews: [{ kind: 'CHAIN_BREAK', status: 'OPEN' }],
    });
    const otherKind = msg({
      amountTiyin: 1n,
      balanceAfterTiyin: 5n,
      reviews: [{ kind: 'NO_MATCH', status: 'RESOLVED' }],
    });
    const noBalance = msg({ balanceAfterTiyin: null });
    const result = chainBreaks(
      [accepted, ignored, noBalance, open, otherKind],
      new Map([['cm3cardA', 0n]]),
    );
    expect(result).toEqual({ breaks: { count: 2, ids: [open.id, otherKind.id] }, reviewed: 2 });
  });
});

describe('debitsByCard and firstParsedPerCard', () => {
  it('sums DEBITs per card and finds each card first PARSED message', () => {
    const rejected = msg({ parseStatus: 'REJECTED', direction: null, outcome: null });
    const a1 = msg({ direction: 'DEBIT', amountTiyin: 250n });
    const a2 = msg({ direction: 'DEBIT', amountTiyin: 50n });
    const b1 = msg({ cardId: 'cm3cardB' });
    const loose = msg({ cardId: null, direction: 'DEBIT' });
    expect(debitsByCard([rejected, a1, a2, b1, loose])).toEqual({
      cm3cardA: { count: 2, sumTiyin: '300' },
      unknownCard: { count: 1, sumTiyin: '100000' },
    });
    expect([...firstParsedPerCard([rejected, a1, a2, b1])]).toEqual([
      ['cm3cardA', a1.tgMessageId],
      ['cm3cardB', b1.tgMessageId],
    ]);
  });
});
