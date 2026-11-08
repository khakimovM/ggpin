import type { CardTotals, Prisma } from '@repo/db';
import type { BankFeedNotifier } from '../../bank-feed/bank-feed-notifier';
import { buildTestEnv } from '../../config/__tests__/test-env';
import type { HistoryRescan, HistoryRescanService } from '../history-rescan.service';
import { PaymentReconcileService } from '../payment-reconcile.service';
import type { ReconcileRepository, WindowMessage } from '../reconcile.repository';

// The verdict, the audit payload and the alert with every collaborator faked (no DB): the
// shared-DB e2e can only assert membership of its own ids, so the "all clean -> reconcileOk"
// verdict and the exact counts are proven here.
const NOW = new Date('2030-05-03T22:00:00.000Z'); // 03:00 Tashkent, 4 May
const CONFIG = buildTestEnv({ TOPUP_CAPACITY_HOLD_SEC: '3600' });
const HOLD_SEC = CONFIG.TOPUP_CAPACITY_HOLD_SEC;

const OK_HISTORY: HistoryRescan = {
  state: 'ok',
  sources: {
    HUMO_BOT: { state: 'ok', reason: null, fetched: 3, recovered: [] },
    UZCARD_BOT: { state: 'ok', reason: null, fetched: 2, recovered: [] },
  },
};

type Payments = Awaited<ReturnType<ReconcileRepository['paymentsSince']>>;

function setup(
  o: {
    history?: HistoryRescan;
    messages?: WindowMessage[];
    payments?: Payments;
    totals?: (CardTotals | undefined)[];
    stuck?: { count: number; ids: string[] };
    staleReviews?: { count: number; ids: string[] };
  } = {},
) {
  const audits: { day: string; after: Prisma.InputJsonObject }[] = [];
  const alerts: [string, string][] = [];
  const cutoffs: Date[] = [];
  const repo: Partial<ReconcileRepository> = {
    messagesSince: () => Promise.resolve(o.messages ?? []),
    previousParsed: () => Promise.resolve(null),
    messagesWithoutOutcome: () => Promise.resolve(o.stuck ?? { count: 0, ids: [] }),
    paymentsWithoutMessage: () => Promise.resolve({ count: 0, ids: [] }),
    pendingPastGrace: () => Promise.resolve({ count: 0, ids: [] }),
    graceEnded: () => Promise.resolve(4),
    paymentsSince: () => Promise.resolve(o.payments ?? []),
    liveCardTotals: () => Promise.resolve(o.totals ?? []),
    openReviews: () => Promise.resolve(2),
    openReviewsOpenedBefore: (before) => {
      cutoffs.push(before);
      return Promise.resolve(o.staleReviews ?? { count: 0, ids: [] });
    },
    possibleReversalsSince: () => Promise.resolve(1),
    writeAudit: (day, after) => {
      audits.push({ day, after });
      return Promise.resolve('cm3audit01');
    },
  };
  const history: Pick<HistoryRescanService, 'rescan'> = {
    rescan: () => Promise.resolve(o.history ?? OK_HISTORY),
  };
  const notifier: Pick<BankFeedNotifier, 'alert'> = {
    alert: (kind, refId) => {
      alerts.push([kind, refId]);
      return Promise.resolve();
    },
  };
  const service = new PaymentReconcileService(
    repo as ReconcileRepository,
    history as HistoryRescanService,
    notifier as BankFeedNotifier,
    CONFIG,
  );
  return { service, audits, alerts, cutoffs };
}

function credit(id: string, over: Partial<WindowMessage> = {}): WindowMessage {
  return {
    id,
    cardId: 'cm3cardA',
    tgMessageId: 1n,
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
    parseStatus: 'PARSED',
    direction: 'CREDIT',
    amountTiyin: 100n,
    balanceAfterTiyin: null,
    outcome: { outcome: 'CREDITED', payment: { amountTiyin: 100n } },
    reviews: [],
    ...over,
  };
}

describe('PaymentReconcileService', () => {
  it('all clean and the history read: reconcileOk with the checked count, keyed by the Tashkent day', async () => {
    const debit = credit('cm3msg2', {
      direction: 'DEBIT',
      tgMessageId: 2n,
      outcome: {
        outcome: 'DEBIT_RECORDED',
        payment: null,
      },
    });
    const { service, audits, alerts } = setup({ messages: [credit('cm3msg1'), debit] });
    const report = await service.run(NOW);
    expect(report.ok).toBe(true);
    expect(report.day).toBe('20300504');
    expect(alerts).toEqual([['reconcileOk', '20300504']]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({
      count: 2,
      debits: 1,
      openReviews: 2,
      historyScan: 'ok',
      checkedMessages: 2,
      debitsByCard: { cm3cardA: { count: 1, sumTiyin: '100' } },
      possibleReversals: 1,
      graceEnded: 4,
      window: { since: '2030-05-01T22:00:00.000Z', until: NOW.toISOString() },
      mismatches: {
        recovered: 0,
        missingOutcome: 0,
        creditUnaccounted: 0,
        paymentWithoutMessage: 0,
        chainBreak: 0,
        pendingPastGrace: 0,
        lateOverLimit: 0,
      },
    });
    // JSON-safe: no BigInt and no text anywhere in the audit payload.
    expect(() => JSON.stringify(audits[0]?.after)).not.toThrow();
  });

  it.each([
    ['unavailable', 'NO_CLIENT'],
    ['failed', 'FOREIGN_CHAT'],
  ] as const)(
    'nothing found but history %s (%s): reconcileMismatch, never a silent ok; the reason is audited',
    async (state, reason) => {
      const history: HistoryRescan = {
        state,
        sources: {
          ...OK_HISTORY.sources,
          UZCARD_BOT: { state, reason, fetched: 0, recovered: [] },
        },
      };
      const { service, audits, alerts } = setup({ history });
      const report = await service.run(NOW);
      expect(report.ok).toBe(false);
      expect(alerts).toEqual([['reconcileMismatch', '20300504']]);
      expect(audits[0]?.after).toMatchObject({
        count: 0,
        historyScan: state,
        history: { UZCARD_BOT: { state, reason, fetched: 0, recovered: 0 } },
      });
    },
  );

  it('S9 I-1: a review OPEN for more than 24 h makes the day a mismatch (oldest ids as examples)', async () => {
    const staleReviews = { count: 2, ids: ['cm3rev1', 'cm3rev2'] };
    const { service, audits, alerts, cutoffs } = setup({ staleReviews });
    const report = await service.run(NOW);
    expect(report.ok).toBe(false);
    expect(cutoffs).toEqual([new Date(NOW.getTime() - 24 * 60 * 60 * 1000)]);
    expect(alerts).toEqual([['reconcileMismatch', '20300504']]);
    expect(audits[0]?.after).toMatchObject({
      count: 2,
      mismatches: { reviewOpenOver24h: 2 },
      examples: { reviewOpenOver24h: ['cm3rev1', 'cm3rev2'] },
    });
  });

  it('missingOutcome comes from the all-time count, not the window (a stuck message stays)', async () => {
    const { service, audits } = setup({ stuck: { count: 3, ids: ['cm3old1', 'cm3old2'] } });
    const report = await service.run(NOW);
    expect(report.ok).toBe(false);
    expect(report.mismatches.missingOutcome).toEqual({ count: 3, ids: ['cm3old1', 'cm3old2'] });
    expect(audits[0]?.after).toMatchObject({ count: 3, mismatches: { missingOutcome: 3 } });
  });

  it('a chain gap the owner already resolved is information (chainBreaksReviewed), not a mismatch', async () => {
    const first = credit('cm3c1', { tgMessageId: 1n, balanceAfterTiyin: 1_000n });
    const gap = credit('cm3c2', {
      tgMessageId: 2n,
      balanceAfterTiyin: 9_000n,
      reviews: [{ kind: 'CHAIN_BREAK', status: 'RESOLVED' }],
    });
    const { service, audits, alerts } = setup({ messages: [first, gap] });
    const report = await service.run(NOW);
    expect(report.ok).toBe(true);
    expect(report.chainBreaksReviewed).toBe(1);
    expect(alerts).toEqual([['reconcileOk', '20300504']]);
    expect(audits[0]?.after).toMatchObject({
      chainBreaksReviewed: 1,
      mismatches: { chainBreak: 0 },
    });
  });

  it('a recovered message is a finding, with its id among the examples', async () => {
    const history: HistoryRescan = {
      state: 'ok',
      sources: {
        ...OK_HISTORY.sources,
        HUMO_BOT: { state: 'ok', reason: null, fetched: 3, recovered: ['cm3r1'] },
      },
    };
    const { service, audits, alerts } = setup({ history });
    await service.run(NOW);
    expect(alerts).toEqual([['reconcileMismatch', '20300504']]);
    expect(audits[0]?.after).toMatchObject({
      count: 1,
      mismatches: { recovered: 1 },
      examples: { recovered: ['cm3r1'] },
    });
  });

  it('lateOverLimit: only a payment past its capacity hold on a card now over its limit', async () => {
    const expiresAt = new Date(NOW.getTime() - 3 * 3_600_000);
    const late = new Date(expiresAt.getTime() + HOLD_SEC * 1000 + 1);
    const inHold = new Date(expiresAt.getTime() + HOLD_SEC * 1000);
    const payments: Payments = [
      { id: 'cm3payLate', intent: { expiresAt, paidAt: late }, bankMessage: { cardId: 'cm3over' } },
      {
        id: 'cm3payHold',
        intent: { expiresAt, paidAt: inHold },
        bankMessage: { cardId: 'cm3over' },
      },
      {
        id: 'cm3payUnder',
        intent: { expiresAt, paidAt: late },
        bankMessage: { cardId: 'cm3under' },
      },
    ];
    const card = (id: string, receivedTiyin: bigint): CardTotals => ({
      card: { id, receiveLimitTiyin: 1_000n, monthlyLimitTiyin: null } as CardTotals['card'],
      receivedTiyin,
      receivedMonthTiyin: receivedTiyin,
      reservedTiyin: 0n,
    });
    const { service, audits } = setup({
      payments,
      totals: [card('cm3over', 1_001n), card('cm3under', 1_000n)],
    });
    const report = await service.run(NOW);
    expect(report.mismatches.lateOverLimit).toEqual({ count: 1, ids: ['cm3payLate'] });
    expect(audits[0]?.after).toMatchObject({ examples: { lateOverLimit: ['cm3payLate'] } });
  });
});
