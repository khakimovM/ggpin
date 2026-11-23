import { randomUUID } from 'node:crypto';
import { validationError } from '../../common/admin/admin-input';
import { ReviewEffects } from '../../modules/payments/review-effects';
import { WalletAdminService, type WalletChange } from '../../modules/wallet/wallet-admin.service';
import {
  adjustBindingFlags,
  adjustOtpTarget,
  recentSetHash,
  reverseOtpTarget,
} from '../../modules/wallet/wallet-admin.input';
import {
  OPEN_ORDERS_REASON,
  openOrdersConfirmed,
  openOrdersSetHash,
} from '../../modules/wallet/wallet-open-orders';
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
import {
  explainSetChange,
  openOrdersSetOf,
  overrideSetOf,
  refuseBareSetFlags,
  showOpenOrders,
  showRecent,
} from './wallet-adjust.cli-view';

const KEY_SHAPE = /^[A-Za-z0-9_]{1,64}$/;

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
    `wallet:adjust --user <userId> --amount <so'm, not 0> --key <id> [--confirm-override=<set>] [--confirm-open-orders=<set>] ${ACTOR_USAGE}` +
    '   (a negative amount is written --amount=-500; --key makes a re-run safe: the same key ' +
    'and request write nothing again, run without it once to get a fresh one; ' +
    '--confirm-override=<set>: add money although the user got automatic top-ups recently; <set> is ' +
    'the recentAutoTopupSet the command printed, so it confirms exactly those payments; here the ' +
    'flag TAKES A VALUE, unlike the bare --confirm-override of review:credit and card:resume; ' +
    '--confirm-open-orders=<set>: add money although the user has open orders (I-5); <set> is the ' +
    'openOrdersSet the command printed)',
  async run(ctx, argv) {
    refuseBareSetFlags(argv);
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        user: { type: 'string' },
        amount: { type: 'string' },
        key: { type: 'string' },
        'confirm-override': { type: 'string' },
        'confirm-open-orders': { type: 'string' },
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
    const openSet = openOrdersSetOf(p);
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
    // I-5: an open order may still be refunded automatically; compensation on top pays twice.
    const open = await showOpenOrders(ctx, wallets, userId, amountTiyin);
    if (!openOrdersConfirmed(amountTiyin, open, openSet)) {
      // CR #2: a given set must still be the current one, even with nothing open any more (an
      // order the owner confirmed may have been refunded automatically in between).
      if (open.length > 0) {
        ctx.io.err('this run wrote nothing; the user has open orders (above).');
        ctx.io.err(
          'if the money is owed anyway, run again with the set and the same --key: ' +
            `--confirm-open-orders=<openOrdersSet> --key ${key}`,
        );
      } else {
        ctx.io.err(
          'this run wrote nothing; the open orders you confirmed are closed now (one may have ' +
            "been refunded automatically): check the user's orders before paying.",
        );
        ctx.io.err(
          'if the money is still owed, run again without --confirm-open-orders and the same ' +
            `--key ${key}`,
        );
      }
      throw validationError('user', OPEN_ORDERS_REASON);
    }
    const flags = adjustBindingFlags(recent, overrideSet !== undefined, open);
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
          ...(openSet === undefined ? {} : { confirmOpenOrdersSet: openSet }),
          ...confirmation.fields,
        }),
      );
    } catch (error) {
      await explainSetChange(ctx, error, async () => {
        const now = await showRecent(ctx, wallets, userId, amountTiyin);
        const openNow = await showOpenOrders(ctx, wallets, userId, amountTiyin);
        return (
          now.length === recent.length &&
          recentSetHash(now) === recentSetHash(recent) &&
          openNow.length === open.length &&
          openOrdersSetHash(openNow) === openOrdersSetHash(open)
        );
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
