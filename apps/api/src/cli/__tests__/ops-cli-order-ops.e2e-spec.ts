import { randomBytes } from 'node:crypto';
import { resolveNeedsReview } from '@repo/db';
import { notifyJobId, tiyinToSom } from '@repo/shared';
import { asRefusal } from '../../modules/orders/admin/order-admin-errors';
import {
  RECIPIENT,
  buildOrdersCatalog,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';
import { moneyOf, notSentProof, reviewOrder, type TransferRow } from './order-cli.fixtures';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// order:resolve under concurrency, the owner's chain proofs (TON_BOUNCED, TON_UNMATCHED_RESOLVED)
// and the read commands on the real database (phase 5 S10 and its fix round, CR M2, M3, m5). Two
// resolves, or a resolve and the reconciler, pay ONE refund; the read commands never print the
// recipient or the provider handle. order:retry: ops-cli-order-retry.e2e-spec.ts.

const t = useOpsE2e();
const WHO = ['--reason', 'checked the wallet history', '--operator', ACTOR.operator];
let catalog: OrdersCatalog;
const hex64 = (): string => randomBytes(32).toString('hex');
const SOM = tiyinToSom(550_000n);

beforeAll(async () => {
  catalog = await buildOrdersCatalog(t.db(), randomBytes(4).toString('hex'));
});

function fields(out: readonly string[]): Record<string, string> {
  const all: Record<string, string> = {};
  for (const line of out) {
    const at = line.indexOf('=');
    if (at > 0) all[line.slice(0, at)] = line.slice(at + 1);
  }
  return all;
}

async function expiredReview(userId: string) {
  const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
  if (transfer === null) throw new Error('no transfer');
  return { orderId, transfer };
}

describe('order:resolve under concurrency (real Postgres)', () => {
  it('two resolves of one order at once: one writes, the other replays; ONE refund, ONE audit', async () => {
    const userId = await t.user();
    const { orderId, transfer } = await expiredReview(userId);
    const argv = [
      'order:resolve',
      orderId,
      '--failed',
      '--proof',
      JSON.stringify(notSentProof(transfer)),
      ...WHO,
    ];
    const runs = await Promise.all([t.run(argv), t.run(argv)]);
    expect(runs.map((r) => r.code)).toEqual([0, 0]);
    expect(runs.map((r) => fields(r.out)['applied']).sort()).toEqual(['false', 'true']);
    const after = await moneyOf(t.db(), orderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.refunds).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });

  it('a resolve racing the reconciler: one of them resolves, ONE refund, no deadlock', async () => {
    const userId = await t.user();
    const { orderId, transfer } = await expiredReview(userId);
    const proof = notSentProof(transfer);
    const reconciler = t
      .db()
      .$transaction((tx) =>
        resolveNeedsReview(tx, {
          orderId,
          to: 'FAILED',
          proof: { ...proof, reason: 'reconciler: expired, seqno unchanged' },
          resolver: { kind: 'reconciler' },
        }),
      )
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'error'),
      );
    const cli = t.run([
      'order:resolve',
      orderId,
      '--failed',
      '--proof',
      JSON.stringify(proof),
      ...WHO,
    ]);
    const [byReconciler, byCli] = await Promise.all([reconciler, cli]);
    // Whoever loses sees the order out of review: the CLI replays (same exit, same proof kind),
    // the reconciler's compare-and-set fails without writing.
    expect(byCli.code).toBe(0);
    if (byReconciler === 'resolved') expect(fields(byCli.out)['applied']).toBe('false');
    else expect(fields(byCli.out)['applied']).toBe('true');
    const after = await moneyOf(t.db(), orderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.refunds).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });
});

describe('order:list / order:show (real Postgres)', () => {
  it('print ids, states, transfers and ledger, never the recipient or the provider handle', async () => {
    const userId = await t.user();
    const { orderId, transfer } = await expiredReview(userId);
    const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
    const show = await t.run(['order:show', orderId]);
    expect(show.code).toBe(0);
    const printed = show.out.join('\n');
    expect(printed).toContain(`order=${orderId}`);
    expect(printed).toContain(transfer.extMsgHash);
    expect(printed).toContain('TON_NOT_SENT (--failed)');
    expect(printed).toContain('ledger=PURCHASE');
    expect(printed).toContain('recipient=hidden');

    const list = await t.run(['order:list', '--status', 'NEEDS_REVIEW', '--limit', '100']);
    expect(list.code).toBe(0);
    const listed = list.out.join('\n');
    expect(listed).toContain(orderId);
    expect(list.out.length).toBeLessThanOrEqual(102);
    for (const secret of [RECIPIENT.username, RECIPIENT.displayName, order.providerRef ?? 'ref_']) {
      expect(printed).not.toContain(secret);
      expect(listed).not.toContain(secret);
    }
    expect((await t.run(['order:list', '--limit', '101'])).code).toBe(1);
    expect((await t.run(['order:list', '--status', 'NOPE'])).code).toBe(1);
  });
});

describe('owner chain proofs (real Postgres)', () => {
  const RETURN_LT_STEP = 6n;

  /** A NEEDS_REVIEW order whose transfer BOUNCED, the bounce recorded by the TON module (S5). */
  async function bouncedReview(userId: string) {
    const returnTxHash = hex64();
    const bounceOf = (transfer: TransferRow | null) => ({
      ton: {
        bounce: {
          txHash: transfer?.txHash ?? '',
          txLt: (transfer?.txLt ?? 0n).toString(),
          returnTxHash,
          returnLt: ((transfer?.txLt ?? 0n) + RETURN_LT_STEP).toString(),
          returnedNanoTon: '230000000',
        },
      },
    });
    const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'BOUNCED', {
      response: bounceOf,
    });
    if (transfer === null) throw new Error('no transfer');
    return {
      orderId,
      proof: { kind: 'TON_BOUNCED', transferId: transfer.id, ...bounceOf(transfer).ton.bounce },
    };
  }

  it('CR M2: TON_BOUNCED as the worker recorded it refunds with the owner code; another returnLt writes nothing', async () => {
    const userId = await t.user();
    const { orderId, proof } = await bouncedReview(userId);
    const lie = { ...proof, returnLt: (BigInt(proof.returnLt) + 1n).toString() };
    const refused = await t.run([
      'order:resolve',
      orderId,
      '--failed',
      '--proof',
      JSON.stringify(lie),
      ...WHO,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.asked).toEqual([]);
    expect(refused.err.join('\n')).toContain('BOUNCE_FACTS_MISMATCH');
    expect(await moneyOf(t.db(), orderId)).toMatchObject({
      status: 'NEEDS_REVIEW',
      refunds: [],
      audits: [],
    });

    const argv = ['order:resolve', orderId, '--failed', '--proof', JSON.stringify(proof), ...WHO];
    const ok = await t.run(argv, [SOM, t.codeFor(`order ${orderId} FAILED TON_BOUNCED`)]);
    expect(ok.err).toEqual([]);
    expect(ok.code).toBe(0);
    const after = await moneyOf(t.db(), orderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.refunds.map((r) => r.amountTiyin)).toEqual([550_000n]);
    expect(after.audits).toHaveLength(1);
  });

  async function unmatchedReview(userId: string, finding: 'SENT_ELSEWHERE' | 'NOT_SENT') {
    const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'CONSUMED_UNMATCHED');
    if (transfer === null) throw new Error('no transfer');
    const proof = {
      kind: 'TON_UNMATCHED_RESOLVED',
      transferId: transfer.id,
      finding,
      consumingTxHash: hex64(),
    };
    const argv = ['order:resolve', orderId, '--failed', '--proof', JSON.stringify(proof), ...WHO];
    const target = `order ${orderId} FAILED TON_UNMATCHED_RESOLVED ${finding}`;
    const compromisedJob = notifyJobId({
      kind: 'OWNER_ALERT',
      alert: 'tonWalletCompromised',
      refId: transfer.id,
    });
    return { orderId, argv, target, compromisedJob };
  }

  it('CR M3: SENT_ELSEWHERE refunds once and queues tonWalletCompromised (refId = transfer); a replay queues it again', async () => {
    const userId = await t.user();
    const u = await unmatchedReview(userId, 'SENT_ELSEWHERE');
    const first = await t.run(u.argv, [SOM, t.codeFor(u.target)]);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out).toContain('securityAlertQueued=true');
    const after = await moneyOf(t.db(), u.orderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.refunds).toHaveLength(1);
    const job = await t.notifyJob(u.compromisedJob);
    expect(job?.data).toEqual({
      kind: 'OWNER_ALERT',
      alert: 'tonWalletCompromised',
      refId: expect.any(String) as unknown,
    });

    // Lost from Redis (say, a flush): the re-run inside the dedupe window queues it again and
    // writes nothing.
    await job?.remove();
    const again = await t.run(u.argv);
    expect(again.code).toBe(0);
    expect(again.asked).toEqual([]);
    expect(again.out).toContain('applied=false');
    expect(await t.notifyJob(u.compromisedJob)).toBeDefined();
    const replayed = await moneyOf(t.db(), u.orderId);
    expect(replayed.refunds).toHaveLength(1);
    expect(replayed.audits).toHaveLength(1);
  });

  it('NOT_SENT refunds without the security alert', async () => {
    const userId = await t.user();
    const u = await unmatchedReview(userId, 'NOT_SENT');
    const ok = await t.run(u.argv, [SOM, t.codeFor(u.target)]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('securityAlertQueued=-');
    expect((await moneyOf(t.db(), u.orderId)).refunds).toHaveLength(1);
    expect(await t.notifyJob(u.compromisedJob)).toBeUndefined();
  });

  it('CR m5: the real P2002 of the return-tx index maps to RETURN_TX_REUSED, never a raw error', async () => {
    // Two resolutions racing on one bounce: the second AuditLog insert hits the partial unique
    // index. Reproduced directly (two probe rows on random ids) to record the real error shape.
    const returnTxHash = hex64();
    const row = (targetId: string) => ({
      actorType: 'SYSTEM' as const,
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      targetId,
      before: {},
      after: { proof: { returnTxHash } },
      reason: 'p2002 shape probe (S10 fix round)',
    });
    await t.db().auditLog.create({ data: row(`probe-${hex64().slice(0, 12)}`) });
    const error: unknown = await t
      .db()
      .auditLog.create({ data: row(`probe-${hex64().slice(0, 12)}`) })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(asRefusal(error)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'proof', reason: 'RETURN_TX_REUSED' },
    });
  });
});
