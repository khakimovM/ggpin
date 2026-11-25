import { QUEUES, parseMajor } from '@repo/shared';
import { Queue } from 'bullmq';
import type { TonChainWitness } from '../ton-gateway';
import { HINT_TRANSIENT_LOOKS, foreignRef } from '../ton-late-hint';
import { E2E_PAY_ADDRESSES, payRequest, rowsOf, tonFactOf } from './ton-e2e.fixtures';
import { useTonE2e } from './ton-e2e.harness';
import { falselyConsumed } from './ton-false-consumed.fixtures';
import { consumedByTwin, hex, lateServiceOf, ledgerOf } from './ton-late.e2e-kit';

// S9f on the real database: the owner's Z6 hint for a CONSUMED_UNMATCHED transfer (checked on the
// primary source and every witness, each final refusal kept with its code; no witness yet, or a
// source that has not listed the transaction yet, is a wait: review F2), accepted only once the
// destination processed the message (F7 / L-4), and ONCHAIN_FAILED (only when every source lists the
// very transaction with nothing sent). Neither moves the order or money.

const t = useTonE2e();
const notify: { queue?: Queue } = {};

beforeAll(() => {
  notify.queue = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
});

afterAll(async () => {
  await notify.queue?.close();
});

/** Every queued `tonSeqnoUnmatched` job of this transfer (any refId suffix): id and queue time. */
async function unmatchedJobsOf(transferId: string): Promise<string[]> {
  const queue = notify.queue;
  if (queue === undefined) throw new Error('no notify queue');
  const jobs = await queue.getJobs(['waiting', 'delayed', 'paused', 'prioritized', 'completed']);
  const prefix = `alert-tonSeqnoUnmatched-${transferId}`;
  return jobs
    .filter((job) => job.id?.startsWith(prefix) === true)
    .map((job) => `${job.id ?? ''}@${String(job.timestamp)}`)
    .sort();
}

describe('TON late facts: the Z6 hint (S9f, Q-7)', () => {
  it('waits without a witness and while not listed; kept REJECTED for a payee off the list; ACCEPTED when all holds', async () => {
    const { fixture, request, gateway, ton, transferId, ref } = await falselyConsumed(t);
    const ledger = await ledgerOf(t.db, fixture.userId);
    const verdict = async () => tonFactOf((await rowsOf(t.db, fixture)).attempt.response, 'hint');

    // F2: no witness is no verdict; the chain is not even read.
    const lone = lateServiceOf(ton.moduleRef, gateway);
    const reads = gateway.callCount('getTransactions');
    const h1 = { auditId: 'audit-h1', ...ref };
    expect(await lone.checkHint(transferId, h1)).toEqual({ kind: 'WAIT', why: 'NO_WITNESS' });
    expect(await lone.checkHint(transferId, h1)).toEqual({ kind: 'WAIT', why: 'NO_WITNESS' });
    expect(gateway.callCount('getTransactions')).toBe(reads);
    expect(await verdict()).toBeNull();

    // F2: "not listed" waits HINT_TRANSIENT_LOOKS looks of the same hint, then it is the verdict.
    const witnessed = lateServiceOf(ton.moduleRef, gateway, [gateway.freshConnection()]);
    const wrongLt = { auditId: 'audit-h2', txHash: ref.txHash, lt: String(BigInt(ref.lt) + 1n) };
    for (let look = 1; look < HINT_TRANSIENT_LOOKS; look += 1) {
      expect(await witnessed.checkHint(transferId, wrongLt)).toEqual({
        kind: 'WAIT',
        why: 'TX_NOT_FOUND',
      });
    }
    expect(await verdict()).toBeNull();
    expect(await witnessed.checkHint(transferId, wrongLt)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_REJECTED',
    });
    expect(await verdict()).toMatchObject({ auditId: 'audit-h2', code: 'TX_NOT_FOUND' });

    E2E_PAY_ADDRESSES.delete(request.toAddress);
    try {
      await witnessed.checkHint(transferId, { auditId: 'audit-h3', ...ref });
    } finally {
      E2E_PAY_ADDRESSES.add(request.toAddress);
    }
    expect(await verdict()).toMatchObject({ auditId: 'audit-h3', code: 'PAYEE_NOT_ALLOWED' });
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('CONSUMED_UNMATCHED');

    // The hint the lone service waited on passes now that a witness exists.
    const h4 = { auditId: 'audit-h4', ...ref };
    expect(await witnessed.checkHint(transferId, h4)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_ACCEPTED',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toMatchObject({ status: 'CONFIRMED', txHash: ref.txHash });
    expect(rows.attempt).toMatchObject({
      status: 'UNKNOWN',
      response: {
        ton: {
          hint: { auditId: 'audit-h4', verdict: 'ACCEPTED' },
          late: { from: 'CONSUMED_UNMATCHED', via: 'HINT', auditId: 'audit-h4' },
        },
      },
    });
    // Z6 is manual (owner 2026-11-18): the order waits for the owner's TON_TX.
    expect(rows.order.status).toBe('NEEDS_REVIEW');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId }]);
    expect(await witnessed.checkHint(transferId, h4)).toEqual({
      kind: 'NOTHING',
      why: 'NOT_ELIGIBLE',
    });
  });

  it("a message our wallet signed that is none of the order's transfers: FOREIGN_MESSAGE, a NEW tonSeqnoUnmatched once (F3, CR m2)", async () => {
    const { fixture, transferId, ref } = await consumedByTwin(t);
    // S5 told the owner when the seqno went (its own job id, still there): the new finding must
    // reach the owner anyway, under its own refId, once.
    const unmatched = { kind: 'ALERT', alert: 'tonSeqnoUnmatched', refId: transferId } as const;
    const foreign = { ...unmatched, refId: foreignRef(transferId) };
    await t.expectJobs([unmatched]);
    await t.expectNoJob(foreign);
    const witnessed = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    const hint = { auditId: 'audit-twin', ...ref };
    expect(await witnessed.checkHint(transferId, hint)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_REJECTED',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONSUMED_UNMATCHED');
    expect(tonFactOf(rows.attempt.response, 'hint')).toEqual({
      auditId: hint.auditId,
      verdict: 'REJECTED',
      code: 'FOREIGN_MESSAGE',
    });
    await t.expectJobs([unmatched, foreign]);
    await t.expectNoJob({ kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId });
    // A second hint naming the same transaction: the same finding, no second alert.
    const before = await unmatchedJobsOf(transferId);
    expect(before).toHaveLength(2);
    const again = { auditId: 'audit-twin-2', ...ref };
    expect(await witnessed.checkHint(transferId, again)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_REJECTED',
    });
    expect(await unmatchedJobsOf(transferId)).toEqual(before);
  });

  it('a destination that never answers keeps the hint waiting, past any grace (F7, L-4)', async () => {
    const { fixture, gateway, ton, transferId, ref } = await falselyConsumed(t, 'SILENT');
    const witnessed = lateServiceOf(ton.moduleRef, gateway, [gateway.freshConnection()]);
    const hint = { auditId: 'audit-silent', ...ref };
    expect(await witnessed.checkHint(transferId, hint)).toEqual({
      kind: 'WAIT',
      why: 'DESTINATION',
    });
    gateway.advance(24 * 3_600);
    expect(await witnessed.checkHint(transferId, hint)).toEqual({
      kind: 'WAIT',
      why: 'DESTINATION',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONSUMED_UNMATCHED');
    expect(tonFactOf(rows.attempt.response, 'hint')).toBeNull();
  });

  it('a bounced destination: REJECTED DESTINATION_BOUNCED, the owner hears tonBounced', async () => {
    const { fixture, gateway, ton, transferId, ref } = await falselyConsumed(t, 'BOUNCE');
    const witnessed = lateServiceOf(ton.moduleRef, gateway, [gateway.freshConnection()]);
    const hint = { auditId: 'audit-bounced', ...ref };
    expect(await witnessed.checkHint(transferId, hint)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_REJECTED',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONSUMED_UNMATCHED');
    expect(tonFactOf(rows.attempt.response, 'hint')).toEqual({
      auditId: hint.auditId,
      verdict: 'REJECTED',
      code: 'DESTINATION_BOUNCED',
    });
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonBounced', refId: transferId }]);
  });
});

describe('TON late facts: ONCHAIN_FAILED (S9f, R2a)', () => {
  it('proven only by every source; never without a witness or against a disagreeing one', async () => {
    t.ton.hooks.afterStoredFn = () => {
      t.gateway.setBalance(t.wallet.address, parseMajor('TON', '0.01'));
      return Promise.resolve();
    };
    const fixture = await t.order();
    const result = await t.ton.sender.pay(payRequest(fixture));
    t.ton.hooks.afterStoredFn = () => Promise.resolve();
    expect(result).toMatchObject({ status: 'REVIEW', transferStatus: 'BROADCAST' });
    const transferId = (await rowsOf(t.db, fixture)).transfer?.id ?? '';
    const ours = t.gateway.transactionsOf(t.wallet.address).at(-1);
    const ledger = await ledgerOf(t.db, fixture.userId);

    const lone = lateServiceOf(t.ton.moduleRef, t.gateway);
    expect(await lone.onchainFailed(transferId)).toEqual({ kind: 'NOTHING', why: 'NO_WITNESS' });
    const blind: TonChainWitness = {
      getAccountState: (address) => t.gateway.getAccountState(address),
      getTransactions: () => Promise.resolve([]),
    };
    const disagreeing = lateServiceOf(t.ton.moduleRef, t.gateway, [
      t.gateway.freshConnection(),
      blind,
    ]);
    expect(await disagreeing.onchainFailed(transferId)).toEqual({
      kind: 'NOTHING',
      why: 'WITNESS_DISAGREES',
    });
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('BROADCAST');
    // F5: the owner alert names `<orderId>_<transferId>` and is sent only once the proof is written.
    const proven = {
      kind: 'ALERT',
      alert: 'needsReview',
      refId: `${fixture.orderId}_${transferId}`,
    } as const;
    await t.expectNoJob(proven);

    const witnessed = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    expect(await witnessed.onchainFailed(transferId)).toEqual({
      kind: 'WRITTEN',
      what: 'ONCHAIN_FAILED',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toMatchObject({ status: 'ONCHAIN_FAILED', txHash: hex(ours) });
    expect(rows.attempt).toMatchObject({
      status: 'UNKNOWN',
      response: {
        ton: { onchainFailed: { txHash: hex(ours), outMsgCount: 0, sources: 2 } },
      },
    });
    expect(rows.order.status).toBe('NEEDS_REVIEW');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    await t.expectJobs([proven]);
    expect(await witnessed.onchainFailed(transferId)).toEqual({
      kind: 'NOTHING',
      why: 'NOT_ELIGIBLE',
    });
  });
});
