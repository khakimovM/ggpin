import { MAX_SEND_ATTEMPTS, ORDER_ADMIN_LIST_MAX_LIMIT } from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { OrderAdminReadService } from '../../modules/orders/admin/order-admin-read.service';
import {
  ATTEMPT_LIMIT_NOT_SUPPORTED,
  OrderRetryService,
  type RetryOutcome,
} from '../../modules/orders/admin/order-retry.service';
import { printList, printShow } from '../order-view';
import { ORDER_RESOLVE_COMMAND } from './order-resolve.command';
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
    printShow(ctx, await ctx.app.get(OrderAdminReadService).show(positional(p, 0)));
  },
};

const RETRY_USAGE =
  `order:retry <orderId> ${ACTOR_USAGE}\n` +
  '   HELD -> QUEUED and a new fulfill-order job (jobId = orderId); the worker re-checks price,\n' +
  '   limits and the recipient before any payout. An order whose send attempts are used up\n' +
  '   (every attempt proven not sent) is refused: the worker would hold it again.';

/** Why ATTEMPT_LIMIT_NOT_SUPPORTED, in words (plan Q5; the release itself comes with S9). */
const ATTEMPT_LIMIT_EXPLAINED =
  `refused: every send attempt of this order (${String(MAX_SEND_ATTEMPTS)}) was proven NOT sent; ` +
  'the worker would hold it again at once. It is refunded when the hold ages out (plan Q5, ' +
  'HELD_MAX_AGE; built in phase 5 S9). Nothing was written.';

function isAttemptLimitRefusal(error: unknown): boolean {
  return error instanceof AppError && error.details?.['reason'] === ATTEMPT_LIMIT_NOT_SUPPORTED;
}

const retry: CliCommand = {
  name: 'order:retry',
  summary: 'release a HELD order back to fulfillment (HELD -> QUEUED)',
  usage: RETRY_USAGE,
  async run(ctx, argv) {
    const p = parse(argv, ACTOR_OPTIONS, 1);
    const { reason, actor } = actorOf(ctx, p);
    const orderId = positional(p, 0);
    let done: RetryOutcome;
    try {
      done = await ctx.app.get(OrderRetryService).retry({
        orderId,
        reason,
        operator: actor.operator,
        ip: actor.ip ?? null,
        osUser: actor.osUser ?? null,
      });
    } catch (error) {
      if (isAttemptLimitRefusal(error)) ctx.io.err(ATTEMPT_LIMIT_EXPLAINED);
      throw error;
    }
    report(ctx, {
      applied: done.applied,
      order: done.orderId,
      status: 'QUEUED',
      audit: done.auditId,
      jobQueued: done.job === 'QUEUED',
      alertQueued: done.adminAction,
    });
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

export const ORDER_COMMANDS: readonly CliCommand[] = [list, show, retry, ORDER_RESOLVE_COMMAND];
