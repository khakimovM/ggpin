import { TonHintService } from '../../modules/orders/admin/tx-hint.service';
import { TON_HINT_COMMAND } from '../commands/tx-hint.command';
import type { OrderAttemptRow } from '../../modules/orders/admin/order-admin.repository';
import { hintStatus, proofKindOf, resolveCommandOf, type HintLine } from '../order-view';
import { runCommand } from '../ops-cli.runner';
import { NO_SESSION, WHO, fakeApp } from './fake-cli';
import { scriptedIo } from './scripted-io';

// ton:hint (phase 5 S9f) without a database. Its registration in the command list is wiring
// (s9f-wiring.md), so the command is run here directly through the runner.

const TRANSFER = 'cktransfer0000000000000001';
const HASH = 'ab'.repeat(32);
const LONG_WHY = ['--reason', 'found in the hot wallet history', '--operator', 'aziz'];

async function run(argv: readonly string[], hint: jest.Mock) {
  const terminal = scriptedIo([]);
  const app = fakeApp(new Map<unknown, unknown>([[TonHintService, { hint }]]));
  const code = await runCommand(TON_HINT_COMMAND, argv, app, terminal.io, NO_SESSION);
  return { code, ...terminal };
}

const done = {
  applied: true,
  transferId: TRANSFER,
  orderId: 'ckorder0000000000000000001',
  auditId: 'audit-1',
  adminAction: true,
};

describe('ton:hint', () => {
  it('lowercases the hash BEFORE the service parses it (plan §12)', async () => {
    const hint = jest.fn().mockResolvedValue(done);
    const out = await run(
      [TRANSFER, '--tx', ` ${HASH.toUpperCase()} `, '--lt', '48000000000001', ...LONG_WHY],
      hint,
    );
    expect(out.code).toBe(0);
    expect(hint).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: TRANSFER, txHash: HASH, lt: '48000000000001' }),
    );
    expect(out.out).toEqual(expect.arrayContaining(['applied=true', 'audit=audit-1']));
  });

  it('needs --tx, --lt, the transfer and the actor: a usage error, nothing called', async () => {
    const hint = jest.fn().mockResolvedValue(done);
    for (const argv of [
      [TRANSFER, '--lt', '1', ...WHO],
      [TRANSFER, '--tx', HASH, ...WHO],
      ['--tx', HASH, '--lt', '1', ...WHO],
      [TRANSFER, '--tx', HASH, '--lt', '1'],
    ]) {
      expect((await run(argv, hint)).code).toBe(2);
    }
    expect(hint).not.toHaveBeenCalled();
  });
});

describe('order:show: the hint status (S9f)', () => {
  const line = (id: string): HintLine => ({
    id,
    transferId: 'cktransfer0000000000000001',
    txHash: HASH,
    lt: '1',
    createdAt: new Date('2026-11-17T10:00:00.000Z'),
  });
  const verdict = (auditId: string, extra: Record<string, string>) => ({
    ton: { hint: { auditId, ...extra } },
  });

  const CU = 'CONSUMED_UNMATCHED';

  it('pending for the latest undecided hint, replaced for an older one', () => {
    expect(hintStatus(line('a2'), true, null, CU)).toBe('pending (the reconciler checks it)');
    expect(hintStatus(line('a1'), false, verdict('a2', { verdict: 'ACCEPTED' }), CU)).toBe(
      'replaced by a later hint',
    );
  });

  it('the worker verdict of that very hint: accepted, or rejected with its code and message', () => {
    expect(hintStatus(line('a2'), true, verdict('a2', { verdict: 'ACCEPTED' }), CU)).toBe(
      'accepted',
    );
    expect(
      hintStatus(line('a2'), true, verdict('a2', { verdict: 'REJECTED', code: 'TX_FAILED' }), CU),
    ).toBe('rejected: TX_FAILED');
    const other = verdict('a2', {
      verdict: 'REJECTED',
      code: 'OTHER_TRANSFER',
      message: 'OTHER_TRANSFER(cktransfer0000000000000002)',
    });
    expect(hintStatus(line('a2'), true, other, CU)).toBe(
      'rejected: OTHER_TRANSFER OTHER_TRANSFER(cktransfer0000000000000002)',
    );
  });

  it('moot once the transfer left CONSUMED_UNMATCHED; the old verdict is kept (review F8)', () => {
    const scanned = {
      ton: {
        hint: { auditId: 'a2', verdict: 'REJECTED', code: 'TX_NOT_FOUND' },
        late: { from: CU, via: 'SCAN' },
      },
    };
    expect(hintStatus(line('a2'), true, scanned, 'CONFIRMED')).toBe(
      'rejected: TX_NOT_FOUND; moot: transfer CONFIRMED by scan',
    );
    expect(hintStatus(line('a3'), true, scanned, 'CONFIRMED')).toBe(
      'not checked; moot: transfer CONFIRMED by scan',
    );
    expect(hintStatus(line('a2'), true, verdict('a2', { verdict: 'ACCEPTED' }), 'CONFIRMED')).toBe(
      'accepted',
    );
  });
});

describe('order:show: Z6 is manual, the ready command (owner 2026-11-18)', () => {
  const ORDER = 'ckorder0000000000000000001';
  const TX = 'cd'.repeat(32);
  const attempt = (
    transferStatus: string,
    attemptStatus: OrderAttemptRow['status'],
    late: Record<string, string> | null,
  ): OrderAttemptRow => ({
    id: 'ckattempt00000000000000001',
    attemptNo: 1,
    adapter: 'fragment',
    status: attemptStatus,
    externalRef: null,
    error: null,
    response: late === null ? {} : { ton: { late } },
    createdAt: new Date('2026-11-17T10:00:00.000Z'),
    tonTransfer: {
      id: TRANSFER,
      status: transferStatus as NonNullable<OrderAttemptRow['tonTransfer']>['status'],
      seqno: 12,
      validUntil: new Date('2026-11-17T10:05:00.000Z'),
      walletAddress: `0:${'11'.repeat(32)}`,
      toAddress: `0:${'22'.repeat(32)}`,
      amountNanoTon: 1_000_000_000n,
      extMsgHash: 'ef'.repeat(32),
      txHash: transferStatus === 'CONFIRMED' ? TX : null,
      txLt: transferStatus === 'CONFIRMED' ? 48_000_000_000_001n : null,
      confirmedAt: null,
    },
  });
  const viaHint = { from: 'CONSUMED_UNMATCHED', via: 'HINT', auditId: 'a4' };

  it('prints the exact TON_TX resolve for a late-confirmed CU transfer of a NEEDS_REVIEW order', () => {
    const command = resolveCommandOf(
      ORDER,
      'NEEDS_REVIEW',
      attempt('CONFIRMED', 'UNKNOWN', viaHint),
    );
    const proof = JSON.stringify({
      kind: 'TON_TX',
      extMsgHash: 'ef'.repeat(32),
      walletAddress: `0:${'11'.repeat(32)}`,
      txHash: TX,
      lt: '48000000000001',
    });
    expect(command).toBe(
      `order:resolve ${ORDER} --delivered --proof '${proof}' --reason "<what you checked>" --operator <name>`,
    );
  });

  it('no command without the late CU fact, for a closed attempt or a settled order', () => {
    expect(
      resolveCommandOf(ORDER, 'NEEDS_REVIEW', attempt('CONFIRMED', 'UNKNOWN', null)),
    ).toBeNull();
    const fromExpired = { from: 'EXPIRED', via: 'SCAN' };
    expect(
      resolveCommandOf(ORDER, 'NEEDS_REVIEW', attempt('CONFIRMED', 'UNKNOWN', fromExpired)),
    ).toBeNull();
    expect(
      resolveCommandOf(ORDER, 'NEEDS_REVIEW', attempt('CONFIRMED', 'CONFIRMED', viaHint)),
    ).toBeNull();
    expect(
      resolveCommandOf(ORDER, 'DELIVERED', attempt('CONFIRMED', 'UNKNOWN', viaHint)),
    ).toBeNull();
    expect(
      resolveCommandOf(ORDER, 'NEEDS_REVIEW', attempt(CU_STATUS, 'UNKNOWN', viaHint)),
    ).toBeNull();
  });

  it('no command once the value came back or the destination aborted', () => {
    for (const fact of ['lateBounce', 'lateDestination']) {
      const a = attempt('CONFIRMED', 'UNKNOWN', viaHint);
      const returned = { ...a, response: { ton: { late: viaHint, [fact]: { orderStatus: 'X' } } } };
      expect(resolveCommandOf(ORDER, 'NEEDS_REVIEW', returned)).toBeNull();
    }
  });

  it('a late fact on an EXPIRED transfer: TON_NOT_SENT is not offered (S9f L-1)', () => {
    const expired = attempt('EXPIRED', 'UNKNOWN', { from: 'EXPIRED', outcome: 'SUSPECT' });
    const transfer = expired.tonTransfer;
    if (transfer === null) throw new Error('fixture');
    expect(proofKindOf(transfer, expired.response)).toMatch(/^none: TON_NOT_SENT is refused/);
    expect(proofKindOf(transfer, {})).toBe('TON_NOT_SENT (--failed)');
  });
});

const CU_STATUS = 'CONSUMED_UNMATCHED';
