import { MAX_SEND_ATTEMPTS, ORDER_ADMIN_LIST_MAX_LIMIT } from '@repo/shared';
import { OrderAdminReadService } from '../../modules/orders/admin/order-admin-read.service';
import { OrderRetryService } from '../../modules/orders/admin/order-retry.service';
import { TonHintService } from '../../modules/orders/admin/tx-hint.service';
import { printList, printShow, transferIdsOf } from '../order-view';
import { ORDER_RESOLVE_COMMAND } from './order-resolve.command';
import { TON_HINT_COMMAND } from './tx-hint.command';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  actorOf,
  parse,
  positional,
  report,
  text,
  UsageError,
  type CliCommand,
} from './command';

const list: CliCommand = {
  name: 'order:list',
  summary: 'list orders, newest first (id, state, product, total, age, reason)',
  usage: `order:list [--status <PAID|QUEUED|PROCESSING|HELD|NEEDS_REVIEW|DELIVERED|FAILED|CANCELLED|REFUNDED>] [--limit <1..${String(ORDER_ADMIN_LIST_MAX_LIMIT)}>]`,
  async run(ctx, argv) {
    const p = parse(argv, { status: { type: 'string' }, limit: { type: 'string' } }, 0);
    const rawLimit = text(p, 'limit');
    if (rawLimit !== undefined && !/^\d{1,3}$/.test(rawLimit)) {
      throw new UsageError('--limit: a whole number');
    }
    const rows = await ctx.app
      .get(OrderAdminReadService)
      .list(text(p, 'status'), rawLimit === undefined ? undefined : Number(rawLimit));
    printList(ctx, rows);
  },
};

const show: CliCommand = {
  name: 'order:show',
  summary: 'one order: events, attempts, TON transfers (state, hash, seqno), ledger, audits',
  usage: 'order:show <orderId>',
  async run(ctx, argv) {
    const p = parse(argv, {}, 1);
    const shown = await ctx.app.get(OrderAdminReadService).show(positional(p, 0));
    // The owner's Z6 hints of the order's transfers (S9f): pending / accepted / rejected: code.
    printShow(ctx, shown, await ctx.app.get(TonHintService).hintsOf(transferIdsOf(shown)));
  },
};

const RETRY_USAGE =
  `order:retry <orderId> ${ACTOR_USAGE}\n` +
  '   HELD -> QUEUED and a new fulfill-order job (jobId = orderId); the worker re-checks price,\n' +
  '   limits and the recipient before any payout. This is the OWNER release: it also starts the\n' +
  `   attempt count again (at most ${String(MAX_SEND_ATTEMPTS)} new send attempts, each only after the\n` +
  '   previous one was proven NOT sent).';

/** The OWNER release starts the worker's attempt count again (S9b, D-66 (2)): said in words. */
export function attemptResetWarning(attemptsUsed: number): string {
  return (
    `warning: ${String(attemptsUsed)} send attempt(s) of this order were already proven NOT ` +
    `sent; this release gives it at most ${String(MAX_SEND_ATTEMPTS)} more (each only after the ` +
    'previous one is proven NOT sent)'
  );
}

const retry: CliCommand = {
  name: 'order:retry',
  summary: 'release a HELD order back to fulfillment (HELD -> QUEUED)',
  usage: RETRY_USAGE,
  async run(ctx, argv) {
    const p = parse(argv, ACTOR_OPTIONS, 1);
    const { reason, actor } = actorOf(ctx, p);
    const orderId = positional(p, 0);
    const done = await ctx.app.get(OrderRetryService).retry({
      orderId,
      reason,
      operator: actor.operator,
      ip: actor.ip ?? null,
      osUser: actor.osUser ?? null,
    });
    report(ctx, {
      applied: done.applied,
      order: done.orderId,
      status: 'QUEUED',
      audit: done.auditId,
      jobQueued: done.job === 'QUEUED',
      alertQueued: done.adminAction,
    });
    if (done.attemptsUsed !== null && done.attemptsUsed > 0) {
      ctx.io.err(attemptResetWarning(done.attemptsUsed));
    }
    if (done.job === 'RUNNING') {
      ctx.io.err(
        'warning: the previous fulfill-order job of this order is still running and will not ' +
          'pick the order up again; run order:retry again in a minute (it writes nothing twice)',
      );
    } else if (done.job === 'FAILED') {
      ctx.io.err('warning: the fulfill-order job was not queued; run order:retry again later');
    }
  },
};

export const ORDER_COMMANDS: readonly CliCommand[] = [
  list,
  show,
  retry,
  ORDER_RESOLVE_COMMAND,
  TON_HINT_COMMAND,
];
