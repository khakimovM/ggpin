import type { FulfillmentAlertKind } from '@repo/shared';
import type { TonHotWalletAddress } from '../../../ton/ton-tokens';
import { WALLET_BLOCKED_REMIND_EVERY_MS as PERIOD } from '../guard-ref';
import type { HeldSourcesRepository } from '../held-sources.repository';
import type { WalletScope } from '../order-reconcile.repository';
import type { ReconcileNotifier } from '../reconcile-notifier';
import { WalletBlockedStep } from '../wallet-blocked.step';

// S9c fix 2 -> S9e: a transfer that blocks the hot wallet past TON_CONFIRM_TIMEOUT_MS is named to
// the owner again once per 6-hour period COUNTED FROM THE BLOCK (`<transferId>_wb_<n>`, n >= 1):
// never minutes after the TON module's own alert (S9e fix CR F6). What the list returns (wallet,
// network, status) is the repository's query, proven on the database (held-release e2e).

const TIMEOUT = 300_000;
const CREATED = Date.parse('2026-11-17T05:57:00.000Z');
const BLOCKED = CREATED + TIMEOUT; // 06:02, just after an epoch bucket started
const WALLET = { network: 'testnet', rawAddress: '0:abc' } as unknown as TonHotWalletAddress;

function setup(ids: readonly string[], createdMs = CREATED) {
  const asked: { scope: WalletScope; before: Date }[] = [];
  const sources = {
    blockingTransfers: (scope: WalletScope, before: Date) => {
      asked.push({ scope, before });
      return Promise.resolve(ids.map((id) => ({ id, createdAt: new Date(createdMs) })));
    },
  } as unknown as HeldSourcesRepository;
  const alerts: { alert: FulfillmentAlertKind; refId: string }[] = [];
  const notifier = {
    alert: (alert: FulfillmentAlertKind, refId: string) => {
      alerts.push({ alert, refId });
      return Promise.resolve(true);
    },
  } as unknown as ReconcileNotifier;
  const step = new WalletBlockedStep(sources, notifier, WALLET, { confirmTimeoutMs: TIMEOUT });
  return { step, alerts, asked };
}

describe('WalletBlockedStep', () => {
  it('lists only transfers blocking for a full period, on this wallet and network', async () => {
    const { step, asked } = setup([]);
    const nowMs = BLOCKED + 3 * PERIOD + 7;
    await step.run({ nowMs });
    expect(asked).toEqual([
      {
        scope: { network: 'testnet', rawAddress: '0:abc' },
        before: new Date(nowMs - TIMEOUT - PERIOD + 1),
      },
    ]);
  });

  it('the first reminder a full period after the block (_wb_1), never in the first period', async () => {
    const { step, alerts } = setup(['tr1']);
    // An epoch-bucket rule would have fired here: a new 6-hour bucket began at 06:00.
    const early = await step.run({ nowMs: BLOCKED + PERIOD - 1 });
    expect(early.counts).toEqual({});
    expect(alerts).toEqual([]);
    const report = await step.run({ nowMs: BLOCKED + PERIOD });
    expect(report.counts).toEqual({ reminded: 1 });
    expect(alerts).toEqual([{ alert: 'tonWalletBlocked', refId: 'tr1_wb_1' }]);
  });

  it('the same id for a whole period (deduped), the next period a new one', async () => {
    const { step, alerts } = setup(['tr1']);
    for (const nowMs of [BLOCKED + PERIOD, BLOCKED + 2 * PERIOD - 1, BLOCKED + 2 * PERIOD]) {
      await step.run({ nowMs });
    }
    expect(alerts.map((a) => a.refId)).toEqual(['tr1_wb_1', 'tr1_wb_1', 'tr1_wb_2']);
  });

  it('an id that cannot be an alert id is logged and counted, never sent', async () => {
    const { step, alerts } = setup(['bad_id']);
    const report = await step.run({ nowMs: BLOCKED + PERIOD });
    expect(report.counts).toEqual({ failed: 1 });
    expect(alerts).toEqual([]);
  });
});
