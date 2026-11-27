import { TON_TX_HINT_ACTION } from '@repo/shared';
import { cliChannelForCliModule, type OperatorChannel } from '../operator-channel';
import type { OrderAdminEffects } from '../order-admin-effects';
import type {
  HintAuditInput,
  HintTransfer,
  StoredHintRow,
  TonHintRepository,
} from '../tx-hint.repository';
import { HINT_REASON_MIN, TonHintService, type TonHintInput } from '../tx-hint.service';

// `ton:hint` (phase 5 S9f, D-64 (7), Q-7) without a database: only the owner CLI channel writes
// it, the hint is checked with the shared TonTxHintSchema BEFORE anything is read or written, only
// a CONSUMED_UNMATCHED transfer takes one, and the same hint twice writes one row.

const TRANSFER = 'cktransfer0000000000000001';
const HASH = 'ab'.repeat(32);
const REASON = 'found in the hot wallet history on the explorer';
const INPUT: TonHintInput = {
  transferId: TRANSFER,
  txHash: HASH,
  lt: '48000000000001',
  reason: REASON,
  operator: 'aziz',
  osUser: 'ops',
};

interface Setup {
  readonly transfer?: Omit<HintTransfer, 'id'> | null;
  readonly latest?: StoredHintRow | null;
  readonly channel?: OperatorChannel;
}

function serviceWith(setup: Setup = {}) {
  const transfer = setup.transfer === undefined ? cu() : setup.transfer;
  const createHint = jest.fn((_tx: unknown, _data: HintAuditInput) =>
    Promise.resolve({ id: 'audit-1' }),
  );
  const read = jest.fn(() =>
    Promise.resolve(transfer === null ? null : { id: TRANSFER, ...transfer }),
  );
  const repo = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    transfer: read,
    latestHint: () => Promise.resolve(setup.latest ?? null),
    createHint,
    hintsOf: () => Promise.resolve([]),
  };
  const adminAction = jest.fn((_auditId: string) => Promise.resolve(true));
  const service = new TonHintService(
    repo as unknown as TonHintRepository,
    { adminAction } as unknown as OrderAdminEffects,
    setup.channel ?? cliChannelForCliModule(),
  );
  return { service, createHint, adminAction, read };
}

function cu(
  status: HintTransfer['status'] = 'CONSUMED_UNMATCHED',
  extra: Partial<Omit<HintTransfer, 'id' | 'status'>> = {},
): Omit<HintTransfer, 'id'> {
  return {
    purpose: 'ORDER',
    status,
    seqno: 12,
    orderId: 'ckorder0000000000000000001',
    verdict: null,
    ...extra,
  };
}

describe('TonHintService.hint (ton:hint)', () => {
  it('writes one TON_TX_HINT row (CLI / OWNER actor, the hinted transaction) and alerts after it', async () => {
    const { service, createHint, adminAction } = serviceWith();
    await expect(service.hint(INPUT)).resolves.toEqual({
      applied: true,
      transferId: TRANSFER,
      orderId: 'ckorder0000000000000000001',
      auditId: 'audit-1',
      adminAction: true,
    });
    expect(createHint).toHaveBeenCalledTimes(1);
    expect(createHint.mock.calls[0]?.[1]).toEqual({
      transferId: TRANSFER,
      before: { status: 'CONSUMED_UNMATCHED', seqno: 12 },
      after: {
        txHash: HASH,
        lt: '48000000000001',
        operator: 'aziz',
        osUser: 'ops',
        actor: { type: 'CLI', role: 'OWNER' },
      },
      reason: REASON,
      ip: null,
    });
    expect(adminAction).toHaveBeenCalledWith('audit-1');
    expect(TON_TX_HINT_ACTION).toBe('TON_TX_HINT');
  });

  it('refuses any channel but the owner CLI one before reading anything', async () => {
    const forged = Object.freeze({ kind: 'CLI' }) as unknown as OperatorChannel;
    const { service, createHint, read } = serviceWith({ channel: forged });
    await expect(service.hint(INPUT)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'actor', reason: 'OWNER_REQUIRED' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(createHint).not.toHaveBeenCalled();
  });

  it('refuses a hash or lt the shared schema refuses (one stored spelling: lowercase hex)', async () => {
    const bad: Partial<TonHintInput>[] = [
      { txHash: HASH.toUpperCase() },
      { txHash: HASH.slice(1) },
      { txHash: `${HASH.slice(2)}zz` },
      { lt: '0' },
      { lt: '-1' },
      { lt: '1.5' },
      { lt: '018446744073709551615' },
      { lt: '18446744073709551616' },
      { transferId: 'Not-An-Id' },
    ];
    for (const change of bad) {
      const { service, createHint, read } = serviceWith();
      await expect(service.hint({ ...INPUT, ...change })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(read).not.toHaveBeenCalled();
      expect(createHint).not.toHaveBeenCalled();
    }
  });

  it(`refuses a reason shorter than ${String(HINT_REASON_MIN)} characters`, async () => {
    const { service, createHint } = serviceWith();
    await expect(service.hint({ ...INPUT, reason: 'too short' })).rejects.toMatchObject({
      details: { field: 'reason', reason: 'TOO_SHORT' },
    });
    expect(createHint).not.toHaveBeenCalled();
  });

  it('only a CONSUMED_UNMATCHED transfer takes a hint; an unknown one is NOT_FOUND', async () => {
    for (const status of ['EXPIRED', 'CONFIRMED', 'BROADCAST', 'BOUNCED'] as const) {
      const { service, createHint } = serviceWith({ transfer: cu(status) });
      await expect(service.hint(INPUT)).rejects.toMatchObject({
        details: { field: 'transfer', reason: 'NOT_CONSUMED_UNMATCHED' },
      });
      expect(createHint).not.toHaveBeenCalled();
    }
    const { service } = serviceWith({ transfer: null });
    await expect(service.hint(INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a transfer that is not an ORDER payout is NOT_FOUND, nothing written (audit I-7)', async () => {
    const { service, createHint } = serviceWith({
      transfer: cu('CONSUMED_UNMATCHED', { purpose: 'SELFTEST', orderId: null }),
    });
    await expect(service.hint(INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createHint).not.toHaveBeenCalled();
  });

  it('the same hint after the worker REJECTED it is a new row (a source may have lagged, L-3)', async () => {
    const latest: StoredHintRow = {
      id: 'audit-0',
      transferId: TRANSFER,
      txHash: HASH,
      lt: '48000000000001',
      createdAt: new Date(),
    };
    const rejected = serviceWith({
      latest,
      transfer: cu('CONSUMED_UNMATCHED', { verdict: { auditId: 'audit-0', verdict: 'REJECTED' } }),
    });
    await expect(rejected.service.hint(INPUT)).resolves.toMatchObject({
      applied: true,
      auditId: 'audit-1',
    });
    expect(rejected.createHint).toHaveBeenCalledTimes(1);
    // A verdict of an OLDER hint does not open the door for the latest one.
    const older = serviceWith({
      latest,
      transfer: cu('CONSUMED_UNMATCHED', { verdict: { auditId: 'audit-x', verdict: 'REJECTED' } }),
    });
    await expect(older.service.hint(INPUT)).resolves.toMatchObject({ applied: false });
    expect(older.createHint).not.toHaveBeenCalled();
  });

  it('the same hint again writes nothing and alerts nobody; another transaction is a new row', async () => {
    const latest: StoredHintRow = {
      id: 'audit-0',
      transferId: TRANSFER,
      txHash: HASH,
      lt: '48000000000001',
      createdAt: new Date(),
    };
    const same = serviceWith({ latest });
    await expect(same.service.hint(INPUT)).resolves.toMatchObject({
      applied: false,
      auditId: 'audit-0',
      adminAction: false,
    });
    expect(same.createHint).not.toHaveBeenCalled();
    expect(same.adminAction).not.toHaveBeenCalled();
    const other = serviceWith({ latest: { ...latest, lt: '48000000000002' } });
    await expect(other.service.hint(INPUT)).resolves.toMatchObject({ applied: true });
    expect(other.createHint).toHaveBeenCalledTimes(1);
  });
});
