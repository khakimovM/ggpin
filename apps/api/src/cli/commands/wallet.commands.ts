import { randomUUID } from 'node:crypto';
import { validationError } from '../../common/admin/admin-input';
import { ReviewEffects } from '../../modules/payments/review-effects';
import { WalletAdminService, type WalletChange } from '../../modules/wallet/wallet-admin.service';
import { adjustOtpTarget, reverseOtpTarget } from '../../modules/wallet/wallet-admin.input';
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
    `wallet:adjust --user <userId> --amount <so'm, not 0> --key <id> ${ACTOR_USAGE}` +
    '   (a negative amount is written --amount=-500; --key makes a re-run safe: the same key ' +
    'and request write nothing again, run without it once to get a fresh one)',
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        user: { type: 'string' },
        amount: { type: 'string' },
        key: { type: 'string' },
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
    const confirmation = await confirmIfLarge(
      ctx,
      { action: 'wallet:adjust', amountTiyin, target: adjustOtpTarget(userId, key) },
      true,
    );
    try {
      await changed(
        ctx,
        await ctx.app.get(WalletAdminService).adjust({
          userId,
          amountTiyin,
          reason,
          operator: actor.operator,
          ip: actor.ip ?? null,
          osUser: actor.osUser ?? null,
          auditId: key,
          ...confirmation.fields,
        }),
      );
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
