import { formatMajor, totalAfterDiscount } from '@repo/shared';
import type { OrderShow } from '../modules/orders/admin/order-admin-read.service';
import type { OrderListRow } from '../modules/orders/admin/order-admin.repository';
import { storedBounce } from '../modules/orders/admin/order-review.input';
import { terminalSafe } from './cli-io';
import { money, report, type CliContext } from './commands/command';

// How the order commands print (phase 5 S10). Ids, states, amounts, hashes and our own wallet
// addresses only: the recipient (username, display name), the provider handle and the quote's
// cost are never selected by the repository, so they cannot be printed here.

const MINUTE = 60_000;

/** "3d04h", "2h05m", "7m": how long ago `at` was. */
export function age(at: Date, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at.getTime()) / MINUTE));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${String(days)}d${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${String(hours)}h${String(rest).padStart(2, '0')}m`;
  return `${String(rest)}m`;
}

export function printList(ctx: CliContext, rows: readonly OrderListRow[]): void {
  ctx.io.out('id  #number  status  product  total  age  reason');
  for (const row of rows) {
    const total = totalAfterDiscount(row.priceTiyin, row.discountTiyin);
    const product = `${row.product.slug} x${String(row.quantity)}`;
    ctx.io.out(
      terminalSafe(
        `${row.id}  #${String(row.number)}  ${row.status}  ${product}  ${money(total)}  ` +
          `${age(row.createdAt)}  ${row.statusReason ?? '-'}`,
      ),
    );
  }
  ctx.io.out(`(${String(rows.length)} shown)`);
}

const tonText = (nano: bigint): string => `${formatMajor('TON', nano)} TON`;

/**
 * Which proof a transfer's state can support (docs/06 "isbot turlari"); the helper still binds
 * every number to the rows. An unresolved transfer supports none: the reconciler decides it.
 */
export const PROOF_HINT: Readonly<Record<string, string>> = {
  CONFIRMED: 'TON_TX (--delivered)',
  EXPIRED: 'TON_NOT_SENT (--failed)',
  ONCHAIN_FAILED: 'TON_NOT_DEBITED (--failed, owner code)',
  BOUNCED: 'TON_BOUNCED (--failed, owner code)',
  CONSUMED_UNMATCHED: 'TON_UNMATCHED_RESOLVED (--failed, owner code; docs/06 runbook first)',
  SIGNED: 'none: still unresolved, the reconciler decides it',
  BROADCAST: 'none: still unresolved, the reconciler decides it',
};

function hasFirstExpiryOnly(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const ton: unknown = Reflect.get(response, 'ton');
  if (typeof ton !== 'object' || ton === null) return false;
  const expiry: unknown = Reflect.get(ton, 'expiry');
  return (
    typeof expiry === 'object' && expiry !== null && Reflect.get(expiry, 'first') !== undefined
  );
}

export function printShow(ctx: CliContext, show: OrderShow): void {
  const { order, ledger, audits } = show;
  report(ctx, {
    order: order.id,
    number: order.number,
    status: order.status,
    statusReason: order.statusReason,
    product: order.product.slug,
    deliveryType: order.product.deliveryType,
    quantity: order.quantity,
    total: money(totalAfterDiscount(order.priceTiyin, order.discountTiyin)),
    costCurrency: order.costCurrency,
    user: order.userId,
    // The recipient is personal data: shown in the customer's own app, never in a terminal log.
    recipient: 'hidden',
    createdAt: `${order.createdAt.toISOString()} (${age(order.createdAt)} ago)`,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
  });
  for (const e of order.events) {
    const note = e.note === null ? '' : ` (${e.note})`;
    report(ctx, {
      event: `${e.createdAt.toISOString()} ${e.from ?? '-'} -> ${e.to} by ${e.actor}${note}`,
    });
  }
  for (const a of order.attempts) {
    report(ctx, {
      attempt: `#${String(a.attemptNo)} ${a.id} ${a.adapter} ${a.status} ref=${a.externalRef ?? '-'} error=${a.error ?? '-'} at=${a.createdAt.toISOString()}`,
    });
    const t = a.tonTransfer;
    if (t !== null) {
      const tx = t.txHash === null ? '-' : `${t.txHash}@${t.txLt?.toString() ?? '?'}`;
      report(ctx, {
        transfer: `${t.id} ${t.status} seqno=${String(t.seqno)} validUntil=${t.validUntil.toISOString()} amount=${tonText(t.amountNanoTon)}`,
        transferWallet: t.walletAddress,
        transferTo: t.toAddress,
        transferExtMsgHash: t.extMsgHash,
        transferTx: tx,
        proofKind: PROOF_HINT[t.status] ?? 'none',
      });
    }
    const bounce = storedBounce(a.response);
    if (bounce !== null) {
      report(ctx, {
        bounce: `txHash=${bounce.txHash} txLt=${bounce.txLt} returnTxHash=${bounce.returnTxHash} returnLt=${bounce.returnLt} returnedNanoTon=${bounce.returnedNanoTon}`,
      });
    }
    // S5: a first expiry observation may stay after a witness dispute. It proves nothing: only a
    // transfer in state EXPIRED is "not sent" (TON_NOT_SENT needs it).
    if (hasFirstExpiryOnly(a.response) && t?.status !== 'EXPIRED') {
      report(ctx, {
        expiryObservation: 'one observation only: NOT a proof that the payment was not sent',
      });
    }
  }
  for (const entry of ledger) {
    report(ctx, {
      ledger: `${entry.kind} ${money(entry.amountTiyin)} ${entry.id} at=${entry.createdAt.toISOString()}`,
    });
  }
  for (const audit of audits) {
    report(ctx, { audit: `${audit.id} ${audit.action} at=${audit.createdAt.toISOString()}` });
  }
}
