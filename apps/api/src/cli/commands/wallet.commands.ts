import { randomUUID } from 'node:crypto';
import { validationError } from '../../common/admin/admin-input';
import { AppError } from '../../common/exceptions/app-error';
import { ReviewEffects } from '../../modules/payments/review-effects';
import { WalletAdminService, type WalletChange } from '../../modules/wallet/wallet-admin.service';
import {
  OverrideSetSchema,
  RECENT_AUTO_TOPUPS_SHOWN,
  adjustOtpFlags,
  adjustOtpTarget,
  recentSetHash,
  reverseOtpTarget,
} from '../../modules/wallet/wallet-admin.input';
import { WalletUnfreezeService } from '../../modules/wallet/wallet-unfreeze.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  actorOf,
  confirmIfLarge,
  money,
  parse,
  positional,
  report,
  required,
  somAmount,
  text,
  UsageError,
  type CliCommand,
  type CliContext,
} from './command';

const KEY_SHAPE = /^[A-Za-z0-9_]{1,64}$/;

const OVERRIDE_VALUE_NEEDED =
  'wallet:adjust --confirm-override takes a VALUE: --confirm-override=<recentAutoTopupSet>, the ' +
  '12 lowercase hex characters the command printed (in review:credit and card:resume it is a ' +
  'bare flag without a value)';

/**
 * A bare `--confirm-override` (the review:credit / card:resume form, or wallet:adjust before
 * S9F-L1), at the end of argv or followed by another option, is refused with a clear message
 * BEFORE parsing: parseArgs would only say "argument missing" or "ambiguous".
 */
function refuseBareOverride(argv: readonly string[]): void {
  argv.forEach((arg, i) => {
    const next = argv[i + 1];
    if (arg === '--confirm-override' && (next === undefined || next.startsWith('-'))) {
      throw new UsageError(OVERRIDE_VALUE_NEEDED);
    }
  });
}

/** `--confirm-override=<set>`: the 12-hex set id. */
function overrideSetOf(p: Parameters<typeof text>[0]): string | undefined {
  const value = text(p, 'confirm-override');
  if (value === undefined) return undefined;
  if (!OverrideSetSchema.safeParse(value).success) throw new UsageError(OVERRIDE_VALUE_NEEDED);
  return value;
}

/** Prints the automatic top-ups a positive adjustment would override (ids, amount, time, set). */
async function showRecent(
  ctx: CliContext,
  wallets: WalletAdminService,
  userId: string,
  amount: bigint,
) {
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

/**
 * The set changed between the CLI's read and the service's lock (a top-up arrived meanwhile):
 * RECENT_AUTO_TOPUP, or OTP_MISMATCH when the owner's code was bound to the old set (n1). The
 * new list and set id are printed with the reason; nothing was written.
 */
async function explainSetChange(
  ctx: CliContext,
  error: unknown,
  reshowSame: () => Promise<boolean>,
): Promise<void> {
  if (!(error instanceof AppError)) return;
  const reason = error.details?.['reason'];
  if (reason === 'RECENT_AUTO_TOPUP') {
    ctx.io.err('nothing written: the automatic top-ups changed meanwhile (new list below).');
    await reshowSame();
  } else if (reason === 'OTP_MISMATCH') {
    ctx.io.err(
      'nothing written: the owner code does not match this request (list as of now below).',
    );
    if (!(await reshowSame())) {
      ctx.io.err(
        'the automatic top-ups changed after the code was sent: it was bound to the old set.',
      );
    }
  }
}

// Money corrections (docs/05 §9). The services do the money and the AuditLog in one
// transaction; here the operator's input is read, the amount re-typed and the owner's code asked
// above the threshold, and the owner's adminAction alert queued after the commit (docs/05 §7:
// every money action).

async function changed(ctx: CliContext, change: WalletChange): Promise<void> {
  const alertQueued = change.applied
    ? await ctx.app.get(ReviewEffects).adminAction(change.auditId)
    : false;
  report(ctx, {
    applied: change.applied,
    user: change.userId,
    audit: change.auditId,
    entry: change.ledgerEntryId,
    balance: money(change.balanceTiyin),
    purchaseFrozen: change.frozen,
    // newlyFrozen without its walletFrozen alert: tell the owner another way.
    walletFrozenAlert: change.newlyFrozen ? change.alertQueued : null,
    alertQueued,
  });
}

const adjust: CliCommand = {
  name: 'wallet:adjust',
  summary: "add (+) or take (-) money on a user's wallet (ADJUSTMENT)",
  usage:
    `wallet:adjust --user <userId> --amount <so'm, not 0> --key <id> [--confirm-override=<set>] ${ACTOR_USAGE}` +
    '   (a negative amount is written --amount=-500; --key makes a re-run safe: the same key ' +
    'and request write nothing again, run without it once to get a fresh one; ' +
    '--confirm-override=<set>: add money although the user got automatic top-ups recently; <set> is ' +
    'the recentAutoTopupSet the command printed, so it confirms exactly those payments; here the ' +
    'flag TAKES A VALUE, unlike the bare --confirm-override of review:credit and card:resume)',
  async run(ctx, argv) {
    refuseBareOverride(argv);
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        user: { type: 'string' },
        amount: { type: 'string' },
        key: { type: 'string' },
        'confirm-override': { type: 'string' },
      },
      0,
    );
    const { reason, actor } = actorOf(ctx, p);
    const userId = required(p, 'user');
    const amountTiyin = somAmount(required(p, 'amount'), 'amount', true);
    // The key is the AuditLog id (S8-M1): a timeout followed by a re-run finds the first run.
    const key = text(p, 'key');
    if (key === undefined || key === '') {
      ctx.io.err(`nothing written: run again with --key ${randomUUID().replaceAll('-', '')}`);
      ctx.io.err('(keep that key for every retry of this one adjustment)');
      throw validationError('key', 'REQUIRED');
    }
    // It is also the id the owner's adminAction alert names: the same shape as every alert id.
    if (!KEY_SHAPE.test(key)) throw new UsageError('--key: 1..64 letters, digits or _');
    const wallets = ctx.app.get(WalletAdminService);
    const overrideSet = overrideSetOf(p);
    // S9 F-L1: the matcher may already have credited the money about to be given by hand.
    const recent = await showRecent(ctx, wallets, userId, amountTiyin);
    if (recent.length > 0 && overrideSet !== recentSetHash(recent)) {
      // I-3: an earlier run with this --key may have written before the set changed; the
      // service finds that replay first (applied=false), so the advice is the SAME key.
      ctx.io.err(
        'this run wrote nothing; an earlier run with this --key may have written it. The user ' +
          'got automatic top-ups recently (above).',
      );
      ctx.io.err(
        'if this is not the same money, run again with the new set and the same --key: ' +
          `--confirm-override=<recentAutoTopupSet> --key ${key}`,
      );
      throw validationError('user', 'RECENT_AUTO_TOPUP');
    }
    const flags = adjustOtpFlags(recent, overrideSet !== undefined);
    report(ctx, { confirms: flags === '' ? '-' : flags });
    const confirmation = await confirmIfLarge(
      ctx,
      {
        action: 'wallet:adjust',
        amountTiyin,
        target: adjustOtpTarget(userId, key),
        ...(flags === '' ? {} : { flags }),
      },
      true,
    );
    try {
      await changed(
        ctx,
        await wallets.adjust({
          userId,
          amountTiyin,
          reason,
          operator: actor.operator,
          ip: actor.ip ?? null,
          osUser: actor.osUser ?? null,
          auditId: key,
          ...(overrideSet === undefined ? {} : { confirmOverrideSet: overrideSet }),
          ...confirmation.fields,
        }),
      );
    } catch (error) {
      await explainSetChange(ctx, error, async () => {
        const now = await showRecent(ctx, wallets, userId, amountTiyin);
        return now.length === recent.length && recentSetHash(now) === recentSetHash(recent);
      });
      throw error;
    } finally {
      await confirmation.done();
    }
  },
};

const reverse: CliCommand = {
  name: 'payment:reverse',
  summary: 'reverse a confirmed top-up (TOPUP_REVERSAL; a negative balance freezes purchases)',
  usage: `payment:reverse <paymentId> ${ACTOR_USAGE}`,
  async run(ctx, argv) {
    const p = parse(argv, ACTOR_OPTIONS, 1);
    const { reason, actor } = actorOf(ctx, p);
    const paymentId = positional(p, 0);
    const wallets = ctx.app.get(WalletAdminService);
    const payment = await wallets.payment(paymentId);
    const confirmation = await confirmIfLarge(ctx, {
      action: 'payment:reverse',
      amountTiyin: payment.amountTiyin,
      target: reverseOtpTarget(paymentId),
    });
    try {
      await changed(
        ctx,
        await wallets.reverseTopup({
          paymentId,
          reason,
          operator: actor.operator,
          ip: actor.ip ?? null,
          osUser: actor.osUser ?? null,
          ...confirmation.fields,
        }),
      );
    } finally {
      await confirmation.done();
    }
  },
};

const unfreeze: CliCommand = {
  name: 'user:unfreeze',
  summary: 'allow purchases again for a frozen user (D-41)',
  usage: `user:unfreeze <userId> ${ACTOR_USAGE}`,
  async run(ctx, argv) {
    const p = parse(argv, ACTOR_OPTIONS, 1);
    const { reason, actor } = actorOf(ctx, p);
    const done = await ctx.app.get(WalletUnfreezeService).unfreeze({
      userId: positional(p, 0),
      reason,
      operator: actor.operator,
      ip: actor.ip ?? null,
      osUser: actor.osUser ?? null,
    });
    const alertQueued =
      done.auditId === null ? false : await ctx.app.get(ReviewEffects).adminAction(done.auditId);
    report(ctx, {
      applied: done.applied,
      user: done.userId,
      audit: done.auditId,
      balance: money(done.balanceTiyin),
      alertQueued,
    });
  },
};

export const WALLET_COMMANDS: readonly CliCommand[] = [adjust, reverse, unfreeze];
