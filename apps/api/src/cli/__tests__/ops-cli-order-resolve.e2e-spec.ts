import { randomBytes } from 'node:crypto';
import { notifyJobId, tiyinToSom } from '@repo/shared';
import {
  buildOrdersCatalog,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';
import {
  MANUAL_PROOF,
  heldOrder,
  moneyOf,
  notSentProof,
  reviewOrder,
  tonTxProof,
} from './order-cli.fixtures';
import { sentCodeFor } from '../../common/admin/owner-otp/__tests__/owner-otp.testing';
import { OrderReviewService } from '../../modules/orders/admin/order-review.service';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// order:resolve on the real database (phase 5 S10): one transaction moves NEEDS_REVIEW to
// DELIVERED or to FAILED + REFUND (ORDER/<orderId>) with the AuditLog; the owner's code is asked
// for an owner proof at any amount and for every proof above the threshold (D-46, D-59); a re-run
// writes nothing twice; nothing is written without a proof or out of NEEDS_REVIEW.

const t = useOpsE2e();
const WHO = ['--reason', 'checked the wallet history', '--operator', ACTOR.operator];
let catalog: OrdersCatalog;

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

const resolveArgv = (orderId: string, to: '--failed' | '--delivered', proof: object) => [
  'order:resolve',
  orderId,
  to,
  '--proof',
  JSON.stringify(proof),
  ...WHO,
];

describe('order:resolve (real Postgres)', () => {
  it('--failed with TON_NOT_SENT below the threshold: one REFUND, audit, effects; a re-run writes nothing', async () => {
    const userId = await t.user();
    const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
    if (transfer === null) throw new Error('no transfer');
    await t.cachedBalance(userId, '0');
    const argv = resolveArgv(orderId, '--failed', notSentProof(transfer));

    const first = await t.run(argv);
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.asked).toEqual([]); // TON_NOT_SENT below the threshold: no owner code
    const done = fields(first.out);
    expect(done).toMatchObject({ applied: 'true', resolved: 'FAILED', ownerCode: 'false' });
    const after = await moneyOf(t.db(), orderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.refunds.map((r) => r.amountTiyin)).toEqual([550_000n]);
    expect(done['refundEntry']).toBe(after.refunds[0]?.id);
    expect(after.audits).toHaveLength(1);
    const audit = after.audits[0];
    expect(audit?.id).toBe(done['audit']);
    expect(audit).toMatchObject({ actorType: 'CLI', actorId: null, reason: WHO[1] });
    expect(JSON.stringify(audit?.after)).toContain(ACTOR.operator);
    // The wallet cache is dropped after the commit; the customer and the owner are told.
    expect(await t.cachedBalance(userId, null)).toBeNull();
    expect(done).toMatchObject({ customerNotified: 'true', alertQueued: 'true' });
    const alertId = notifyJobId({
      kind: 'OWNER_ALERT',
      alert: 'reviewResolved',
      refId: `${orderId}_${String(audit?.id)}`,
    });
    expect(await t.notifyJob(alertId)).toBeDefined();

    const again = await t.run(argv);
    expect(again.code).toBe(0);
    expect(again.asked).toEqual([]);
    expect(fields(again.out)).toMatchObject({ applied: 'false', audit: done['audit'] });
    const replay = await moneyOf(t.db(), orderId);
    expect(replay.refunds).toHaveLength(1);
    expect(replay.audits).toHaveLength(1);
  });

  it('MANUAL needs the owner code at any amount: none or a wrong one writes nothing, the right one resolves', async () => {
    const userId = await t.user();
    const { orderId } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
    const argv = resolveArgv(orderId, '--failed', MANUAL_PROOF);
    const som = tiyinToSom(550_000n);

    const noCode = await t.run(argv, [som, '']);
    expect(noCode.code).toBe(1);
    expect(noCode.asked).toHaveLength(2);
    const wrongAmount = await t.run(argv, ['1']);
    expect(wrongAmount.code).toBe(1);
    const wrongCode = await t.run(argv, [som, '000000']);
    expect(wrongCode.code).toBe(1);
    // The service itself refuses, whatever its caller asked (not only the CLI prompt).
    const direct = t.app().get(OrderReviewService);
    const request = {
      orderId,
      to: 'FAILED',
      proof: MANUAL_PROOF,
      reason: WHO[1] ?? '',
      operator: ACTOR.operator,
      confirmOutsideSystem: false,
    } as const;
    await expect(direct.resolve(request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      direct.resolve({ ...request, confirmAmountTiyin: 550_000n }),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_REQUIRED' } });
    let untouched = await moneyOf(t.db(), orderId);
    expect(untouched).toMatchObject({ status: 'NEEDS_REVIEW', refunds: [], audits: [] });

    let code = '';
    const readCode = async (): Promise<string> => {
      code = await sentCodeFor(t.app(), `order ${orderId} FAILED MANUAL`);
      return code;
    };
    const ok = await t.run(argv, [som, readCode]);
    expect(ok.err).toEqual([]);
    expect(ok.code).toBe(0);
    expect(fields(ok.out)).toMatchObject({ applied: 'true', ownerCode: 'true' });
    untouched = await moneyOf(t.db(), orderId);
    expect(untouched.status).toBe('REFUNDED');
    expect(untouched.refunds).toHaveLength(1);
    expect(JSON.stringify(untouched.audits[0]?.after)).toContain('"otpVerified":true');
    // The code is never printed.
    expect(code).toMatch(/^\d{6}$/);
    expect([...ok.out, ...ok.err].join('\n')).not.toContain(code);
  });

  it('above the threshold even a chain proof (TON_TX) needs the re-typed amount and the code', async () => {
    const userId = await t.user();
    const price = 150_000_000n; // 1 500 000 so'm > the 1 000 000 so'm threshold
    const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'CONFIRMED', {
      priceTiyin: price,
    });
    if (transfer === null) throw new Error('no transfer');
    const argv = resolveArgv(orderId, '--delivered', tonTxProof(transfer));
    const refused = await t.run(argv, [tiyinToSom(price), '']);
    expect(refused.code).toBe(1);
    expect((await moneyOf(t.db(), orderId)).status).toBe('NEEDS_REVIEW');

    const ok = await t.run(argv, [tiyinToSom(price), t.codeFor(`order ${orderId} DELIVERED`)]);
    expect(ok.code).toBe(0);
    const after = await moneyOf(t.db(), orderId);
    expect(after).toMatchObject({ status: 'DELIVERED', refunds: [] });
    expect(after.audits).toHaveLength(1);
  });

  it('refuses without a proof, with a malformed or wrong-direction proof, and out of NEEDS_REVIEW', async () => {
    const userId = await t.user();
    const { orderId, transfer } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
    if (transfer === null) throw new Error('no transfer');
    const noProof = await t.run(['order:resolve', orderId, '--failed', ...WHO]);
    expect(noProof.code).toBe(2);
    const notJson = await t.run(['order:resolve', orderId, '--failed', '--proof', '{', ...WHO]);
    expect(notJson.code).toBe(2);
    const badShape = await t.run(resolveArgv(orderId, '--failed', { kind: 'TON_NOT_SENT' }));
    expect(badShape.code).toBe(1);
    // TON_NOT_SENT proves "not sent": it can never deliver.
    const wrongWay = await t.run(resolveArgv(orderId, '--delivered', notSentProof(transfer)));
    expect(wrongWay.code).toBe(1);
    expect(wrongWay.err.join('\n')).toContain('VALIDATION_ERROR');
    // A proof that does not match the stored transfer (another seqno) is refused by @repo/db.
    const lie = await t.run(
      resolveArgv(orderId, '--failed', { ...notSentProof(transfer), seqno: 42, checkedSeqno: 42 }),
    );
    expect(lie.code).toBe(1);
    expect(await moneyOf(t.db(), orderId)).toMatchObject({
      status: 'NEEDS_REVIEW',
      refunds: [],
      audits: [],
    });

    const held = await heldOrder(t.db(), catalog, userId, 'wallet low');
    const notInReview = await t.run(resolveArgv(held, '--failed', MANUAL_PROOF));
    expect(notInReview.code).toBe(1);
    expect(notInReview.asked).toEqual([]);
    expect(notInReview.err.join('\n')).toContain('NOT_IN_REVIEW');
    expect(await moneyOf(t.db(), held)).toMatchObject({ status: 'HELD', refunds: [], audits: [] });
  });

  it('I-8: MANUAL --delivered while TON never left is refused without --delivered-outside-system', async () => {
    const userId = await t.user();
    const { orderId } = await reviewOrder(t.db(), catalog, userId, 'EXPIRED');
    const argv = resolveArgv(orderId, '--delivered', MANUAL_PROOF);
    const warned = await t.run(argv);
    expect(warned.code).toBe(1);
    expect(warned.asked).toEqual([]);
    expect(warned.err.join('\n')).toContain('deliver it outside the system');
    expect(warned.err.join('\n')).toContain('OUTSIDE_SYSTEM_CONFIRMATION_REQUIRED');
    expect((await moneyOf(t.db(), orderId)).audits).toEqual([]);

    const som = tiyinToSom(550_000n);
    const ok = await t.run(
      [...argv, '--delivered-outside-system'],
      [som, t.codeFor(`order ${orderId} DELIVERED MANUAL`)],
    );
    expect(ok.err.filter((l) => !l.startsWith('warning'))).toEqual([]);
    expect(ok.code).toBe(0);
    const after = await moneyOf(t.db(), orderId);
    expect(after).toMatchObject({ status: 'DELIVERED', refunds: [] });
    // Audit L-4: the owner's confirmation is part of the audit row.
    expect(after.audits[0]?.after).toMatchObject({
      acknowledgements: ['DELIVERED_OUTSIDE_SYSTEM'],
    });
  });

  it('re-review N4: --delivered-outside-system where TON did leave is refused; nothing asked or written', async () => {
    const userId = await t.user();
    const { orderId } = await reviewOrder(t.db(), catalog, userId, 'CONFIRMED');
    const argv = [
      ...resolveArgv(orderId, '--delivered', MANUAL_PROOF),
      '--delivered-outside-system',
    ];
    const refused = await t.run(argv);
    expect(refused.code).toBe(1);
    expect(refused.asked).toEqual([]);
    expect(refused.err.join('\n')).toContain('OUTSIDE_SYSTEM_NOT_APPLICABLE');
    expect(await moneyOf(t.db(), orderId)).toMatchObject({ status: 'NEEDS_REVIEW', audits: [] });
  });

  it('I-8 (CR m6): an attempt without a transfer of its own raises no outside-system question', async () => {
    const userId = await t.user();
    const { orderId } = await reviewOrder(t.db(), catalog, userId, null);
    const argv = resolveArgv(orderId, '--delivered', MANUAL_PROOF);
    const ok = await t.run(argv, [
      tiyinToSom(550_000n),
      t.codeFor(`order ${orderId} DELIVERED MANUAL`),
    ]);
    expect(ok.err).toEqual([]);
    expect(ok.code).toBe(0);
    const after = await moneyOf(t.db(), orderId);
    expect(after.status).toBe('DELIVERED');
    expect(after.audits[0]?.after).toMatchObject({ acknowledgements: [] });
  });
});
