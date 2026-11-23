import { AppError } from '../../common/exceptions/app-error';
import type { WalletAdminService } from '../../modules/wallet/wallet-admin.service';
import {
  OverrideSetSchema,
  RECENT_AUTO_TOPUPS_SHOWN,
  recentSetHash,
  type RecentAutoTopup,
} from '../../modules/wallet/wallet-admin.input';
import {
  OPEN_ORDERS_REASON,
  OPEN_ORDERS_SHOWN,
  openOrdersSetHash,
  type OpenOrder,
} from '../../modules/wallet/wallet-open-orders';
import { money, report, text, UsageError, type CliContext } from './command';

// What wallet:adjust shows and reads before a positive adjustment: the recent automatic top-ups
// (S9 F-L1) and the open orders (I-5), each with the set id the owner passes back. Kept apart
// from wallet.commands.ts only for the 300-line file limit.

type Parsed = Parameters<typeof text>[0];

const OVERRIDE_VALUE_NEEDED =
  'wallet:adjust --confirm-override takes a VALUE: --confirm-override=<recentAutoTopupSet>, the ' +
  '12 lowercase hex characters the command printed (in review:credit and card:resume it is a ' +
  'bare flag without a value)';

const OPEN_ORDERS_VALUE_NEEDED =
  'wallet:adjust --confirm-open-orders takes a VALUE: --confirm-open-orders=<openOrdersSet>, the ' +
  '12 lowercase hex characters the command printed';

/**
 * A bare `--confirm-override` (the review:credit / card:resume form, or wallet:adjust before
 * S9F-L1) or a bare `--confirm-open-orders`, at the end of argv or followed by another option, is
 * refused with a clear message BEFORE parsing: parseArgs would only say "argument missing".
 */
export function refuseBareSetFlags(argv: readonly string[]): void {
  argv.forEach((arg, i) => {
    const next = argv[i + 1];
    const bare = next === undefined || next.startsWith('-');
    if (arg === '--confirm-override' && bare) throw new UsageError(OVERRIDE_VALUE_NEEDED);
    if (arg === '--confirm-open-orders' && bare) throw new UsageError(OPEN_ORDERS_VALUE_NEEDED);
  });
}

/** `--confirm-override=<set>`: the 12-hex set id. */
export function overrideSetOf(p: Parsed): string | undefined {
  const value = text(p, 'confirm-override');
  if (value === undefined) return undefined;
  if (!OverrideSetSchema.safeParse(value).success) throw new UsageError(OVERRIDE_VALUE_NEEDED);
  return value;
}

/** `--confirm-open-orders=<set>`: the 12-hex set id (I-5). */
export function openOrdersSetOf(p: Parsed): string | undefined {
  const value = text(p, 'confirm-open-orders');
  if (value === undefined) return undefined;
  if (!OverrideSetSchema.safeParse(value).success) throw new UsageError(OPEN_ORDERS_VALUE_NEEDED);
  return value;
}

/** Prints the automatic top-ups a positive adjustment would override (ids, amount, time, set). */
export async function showRecent(
  ctx: CliContext,
  wallets: WalletAdminService,
  userId: string,
  amount: bigint,
): Promise<readonly RecentAutoTopup[]> {
  const recent = await wallets.recentFor(userId, amount);
  for (const payment of recent.slice(0, RECENT_AUTO_TOPUPS_SHOWN)) {
    const at = payment.confirmedAt?.toISOString() ?? '-';
    report(ctx, { recentAutoTopup: `${payment.id} +${money(payment.amountTiyin)} at ${at}` });
  }
  // The set id covers all of them (recentSetHash); only the newest are printed.
  if (recent.length > RECENT_AUTO_TOPUPS_SHOWN) {
    report(ctx, { recentAutoTopupMore: recent.length - RECENT_AUTO_TOPUPS_SHOWN });
  }
  if (recent.length > 0) report(ctx, { recentAutoTopupSet: recentSetHash(recent) });
  return recent;
}

/** Prints the open orders a positive adjustment must confirm (I-5): number, status, price, set. */
export async function showOpenOrders(
  ctx: CliContext,
  wallets: WalletAdminService,
  userId: string,
  amount: bigint,
): Promise<readonly OpenOrder[]> {
  const open = await wallets.openFor(userId, amount);
  for (const order of open.slice(0, OPEN_ORDERS_SHOWN)) {
    const at = order.createdAt.toISOString();
    report(ctx, {
      openOrder: `${order.id} #${String(order.number)} ${order.status} ${money(order.priceTiyin)} at ${at}`,
    });
  }
  if (open.length > OPEN_ORDERS_SHOWN)
    report(ctx, { openOrderMore: open.length - OPEN_ORDERS_SHOWN });
  if (open.length > 0) report(ctx, { openOrdersSet: openOrdersSetHash(open) });
  return open;
}

/**
 * A set changed between the CLI's read and the service's lock (a top-up arrived, an order was
 * created or finished meanwhile): RECENT_AUTO_TOPUP / OPEN_ORDERS, or OTP_MISMATCH when the
 * owner's code was bound to the old sets (n1). The lists as of now are printed with the reason;
 * nothing was written.
 */
export async function explainSetChange(
  ctx: CliContext,
  error: unknown,
  reshowSame: () => Promise<boolean>,
): Promise<void> {
  if (!(error instanceof AppError)) return;
  const reason = error.details?.['reason'];
  if (reason === 'RECENT_AUTO_TOPUP') {
    ctx.io.err('nothing written: the automatic top-ups changed meanwhile (new list below).');
    await reshowSame();
  } else if (reason === OPEN_ORDERS_REASON) {
    ctx.io.err('nothing written: the open orders changed meanwhile (new list below).');
    await reshowSame();
  } else if (reason === 'OTP_MISMATCH') {
    ctx.io.err(
      'nothing written: the owner code does not match this request (lists as of now below).',
    );
    if (!(await reshowSame())) {
      ctx.io.err(
        'the top-ups or open orders changed after the code was sent: it was bound to the old sets.',
      );
    }
  }
}
