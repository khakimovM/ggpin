import { randomBytes } from 'node:crypto';
import { TON_TX_HINT_ACTION } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  buildOrdersCatalog,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';
import {
  OPERATOR_CHANNEL,
  type OperatorChannel,
} from '../../modules/orders/admin/operator-channel';
import { OrderAdminEffects } from '../../modules/orders/admin/order-admin-effects';
import { TonHintRepository } from '../../modules/orders/admin/tx-hint.repository';
import { TonHintService } from '../../modules/orders/admin/tx-hint.service';
import { reviewOrder } from './order-cli.fixtures';
import { ACTOR, LOCAL_SESSION, useOpsE2e } from './ops-e2e.harness';

// ton:hint on the real database (phase 5 S9f, D-64 (7), Q-7), run by its name through the CLI's
// own command list and module graph (the wiring). A service with another channel is built from the
// module's own providers only where a test needs a forged channel. The hint is one AuditLog row
// (TON_TX_HINT, targetType TonTransfer, actorType CLI); nothing else.

const t = useOpsE2e();
let catalog: OrdersCatalog;
const HASH = 'ef'.repeat(32);
const WHO = ['--reason', 'found in the hot wallet history by hand', '--operator', ACTOR.operator];

beforeAll(async () => {
  catalog = await buildOrdersCatalog(t.db(), randomBytes(4).toString('hex'));
});

function serviceWith(channel?: OperatorChannel): TonHintService {
  const m = t.app();
  return new TonHintService(
    new TonHintRepository(m.get(PrismaService)),
    m.get(OrderAdminEffects),
    channel ?? m.get<symbol, OperatorChannel>(OPERATOR_CHANNEL),
  );
}

function hint(argv: readonly string[]) {
  return t.run(['ton:hint', ...argv]);
}

const hintRows = (transferId: string) =>
  t.db().auditLog.findMany({
    where: { action: TON_TX_HINT_ACTION, targetId: transferId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

async function attemptOf(transferId: string): Promise<string> {
  const row = await t.db().tonTransfer.findUniqueOrThrow({
    where: { id: transferId },
    select: { attemptId: true },
  });
  if (row.attemptId === null) throw new Error('the transfer has no attempt');
  return row.attemptId;
}

/**
 * What the worker leaves when it accepts the hint: CU -> CONFIRMED, the chain data, the late mark.
 * TonTransfer.txHash is unique and the shared test database keeps rows of earlier runs, so the
 * hash is fresh per call (a fixed one made every re-run fail on TonTransfer_txHash_key).
 */
async function workerAccepted(transferId: string, auditId: string): Promise<string> {
  const db = t.db();
  const txHash = randomBytes(32).toString('hex');
  const txLt = 48_000_000_000_777n;
  await db.tonTransfer.update({
    where: { id: transferId },
    data: { status: 'CONFIRMED', txHash, txLt, confirmedAt: new Date() },
  });
  const late = { from: 'CONSUMED_UNMATCHED', outcome: 'CONFIRMED', via: 'HINT', auditId, txHash };
  await db.fulfillmentAttempt.update({
    where: { id: await attemptOf(transferId) },
    data: { response: { ton: { hint: { auditId, verdict: 'ACCEPTED' }, late } } },
  });
  return txHash;
}

describe('ton:hint (real database)', () => {
  it('one TON_TX_HINT row for a CONSUMED_UNMATCHED transfer; the same hint again writes nothing', async () => {
    const { orderId, transfer } = await reviewOrder(
      t.db(),
      catalog,
      await t.user(),
      'CONSUMED_UNMATCHED',
    );
    const transferId = transfer?.id ?? '';
    const before = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
    const out = await hint([transferId, '--tx', HASH.toUpperCase(), '--lt', '4800001', ...WHO]);
    expect(out.code).toBe(0);
    expect(out.out).toEqual(expect.arrayContaining(['applied=true', `order=${orderId}`]));
    const [row, ...more] = await hintRows(transferId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      targetType: 'TonTransfer',
      reason: 'found in the hot wallet history by hand',
      before: { status: 'CONSUMED_UNMATCHED', seqno: 41 },
      after: {
        txHash: HASH,
        lt: '4800001',
        operator: ACTOR.operator,
        osUser: LOCAL_SESSION.osUser,
        actor: { type: 'CLI', role: 'OWNER' },
      },
    });
    // Nothing else moved: the order, the transfer.
    expect(await t.db().order.findUniqueOrThrow({ where: { id: orderId } })).toEqual(before);
    const stored = await t.db().tonTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(stored).toMatchObject({ status: 'CONSUMED_UNMATCHED', txHash: null });

    const again = await hint([transferId, '--tx', HASH, '--lt', '4800001', ...WHO]);
    expect(again.out).toEqual(expect.arrayContaining(['applied=false', `audit=${row?.id ?? ''}`]));
    expect(await hintRows(transferId)).toHaveLength(1);

    const other = await hint([transferId, '--tx', HASH, '--lt', '4800002', ...WHO]);
    expect(other.code).toBe(0);
    const listed = await serviceWith().hintsOf([transferId]);
    expect(listed.map((h) => h.lt)).toEqual(['4800002', '4800001']);
  });

  it('the same hint after the worker REJECTED it is a new row (L-3); a CLI row without the owner actor is no hint (F6)', async () => {
    const { transfer } = await reviewOrder(t.db(), catalog, await t.user(), 'CONSUMED_UNMATCHED');
    const transferId = transfer?.id ?? '';
    const argv = [transferId, '--tx', HASH, '--lt', '4800001', ...WHO];
    expect((await hint(argv)).code).toBe(0);
    const [first] = await hintRows(transferId);
    await t.db().fulfillmentAttempt.update({
      where: { id: await attemptOf(transferId) },
      data: {
        response: { ton: { hint: { auditId: first?.id ?? '', verdict: 'REJECTED', code: 'X' } } },
      },
    });
    const again = await hint(argv);
    expect(again.out).toEqual(expect.arrayContaining(['applied=true']));
    expect(await hintRows(transferId)).toHaveLength(2);
    // A CLI row another writer made (no owner actor in `after`) is neither listed nor the latest.
    await t.db().auditLog.create({
      data: {
        actorType: 'CLI',
        actorId: null,
        action: TON_TX_HINT_ACTION,
        targetType: 'TonTransfer',
        targetId: transferId,
        before: {},
        after: { txHash: HASH, lt: '4800009' },
        reason: 'written by something that is not the owner channel',
        ip: null,
      },
    });
    const listed = await serviceWith().hintsOf([transferId]);
    expect(listed.map((h) => h.lt)).toEqual(['4800001', '4800001']);
    const third = await hint(argv);
    expect(third.out).toEqual(expect.arrayContaining(['applied=false']));
  });

  it('Z6 is manual: order:show prints the ready TON_TX resolve; the owner runs it, DELIVERED', async () => {
    const { orderId, transfer } = await reviewOrder(
      t.db(),
      catalog,
      await t.user(),
      'CONSUMED_UNMATCHED',
    );
    const transferId = transfer?.id ?? '';
    expect((await hint([transferId, '--tx', HASH, '--lt', '4800001', ...WHO])).code).toBe(0);
    const [row] = await hintRows(transferId);
    const txHash = await workerAccepted(transferId, row?.id ?? '');

    const show = await t.run(['order:show', orderId]);
    expect(show.code).toBe(0);
    // The wiring: order:show reads the owner's hints of the order's transfers and their verdicts.
    const hintLine = show.out.find((l) => l.includes(`hint=${row?.id ?? '?'} `)) ?? '';
    expect(hintLine.endsWith('status=accepted')).toBe(true);
    const line = show.out.find((l) => l.startsWith('resolveCommand=')) ?? '';
    expect(line.startsWith(`resolveCommand=order:resolve ${orderId} --delivered --proof '`)).toBe(
      true,
    );
    const proof = /--proof '(\{[^']*\})' --reason/.exec(line)?.[1] ?? '';
    expect(JSON.parse(proof)).toMatchObject({ kind: 'TON_TX', txHash });

    const done = await t.run(['order:resolve', orderId, '--delivered', '--proof', proof, ...WHO]);
    expect(done.err).toEqual([]);
    expect(done.code).toBe(0);
    const order = await t.db().order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('DELIVERED');
    const attempt = await t.db().fulfillmentAttempt.findUniqueOrThrow({
      where: { id: await attemptOf(transferId) },
    });
    expect(attempt.status).toBe('CONFIRMED');
    // Settled: the line is not printed any more.
    const after = await t.run(['order:show', orderId]);
    expect(after.out.some((l) => l.startsWith('resolveCommand='))).toBe(false);
  });

  it('refused for a transfer in any other state, and on any channel but the owner one', async () => {
    const { transfer } = await reviewOrder(t.db(), catalog, await t.user(), 'CONFIRMED');
    const transferId = transfer?.id ?? '';
    const out = await hint([transferId, '--tx', HASH, '--lt', '1', ...WHO]);
    expect(out.code).toBe(1);
    expect(await hintRows(transferId)).toEqual([]);

    const cu = await reviewOrder(t.db(), catalog, await t.user(), 'CONSUMED_UNMATCHED');
    const forged = Object.freeze({ kind: 'CLI' }) as unknown as OperatorChannel;
    await expect(
      serviceWith(forged).hint({
        transferId: cu.transfer?.id ?? '',
        txHash: HASH,
        lt: '1',
        reason: 'found in the hot wallet history by hand',
        operator: ACTOR.operator,
      }),
    ).rejects.toMatchObject({ details: { field: 'actor', reason: 'OWNER_REQUIRED' } });
    expect(await hintRows(cu.transfer?.id ?? '')).toEqual([]);
  });
});
