import { TonHintService, HINT_REASON_MIN } from '../../modules/orders/admin/tx-hint.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  actorOf,
  parse,
  positional,
  report,
  required,
  type CliCommand,
} from './command';

const USAGE =
  `ton:hint <transferId> --tx <64 hex> --lt <decimal> ${ACTOR_USAGE}\n` +
  "   Z6: names the transaction that may carry a CONSUMED_UNMATCHED transfer's payment (found\n" +
  "   in the wallet's history by hand). Nothing changes here: the worker checks it on the\n" +
  '   primary chain source and on at least one witness (our wallet, the seqno, a payee on the\n' +
  '   allowlist, the amount, the payload, no bounce) and writes the transfer CONFIRMED only when\n' +
  '   every check holds. order:show prints the verdict (pending / accepted / rejected: code).\n' +
  `   The reason (at least ${String(HINT_REASON_MIN)} characters) says where it was found.`;

/**
 * ton:hint (phase 5 S9f, D-64 (7), Q-7): the owner's Z6 hint, one AuditLog row TON_TX_HINT, no
 * owner code (no money moves, the worker's checks decide). The hash is lowercased BEFORE it is
 * parsed (plan §12): a hash copied from an explorer in capitals names the same transaction, and the
 * one stored spelling is lowercase hex.
 */
export const TON_HINT_COMMAND: CliCommand = {
  name: 'ton:hint',
  summary: 'name the transaction of a CONSUMED_UNMATCHED transfer (Z6), checked by the worker',
  usage: USAGE,
  async run(ctx, argv) {
    const p = parse(argv, { ...ACTOR_OPTIONS, tx: { type: 'string' }, lt: { type: 'string' } }, 1);
    const { reason, actor } = actorOf(ctx, p);
    const transferId = positional(p, 0);
    const done = await ctx.app.get(TonHintService).hint({
      transferId,
      txHash: required(p, 'tx').trim().toLowerCase(),
      lt: required(p, 'lt').trim(),
      reason,
      operator: actor.operator,
      ip: actor.ip ?? null,
      osUser: actor.osUser ?? null,
    });
    report(ctx, {
      applied: done.applied,
      transfer: done.transferId,
      order: done.orderId,
      audit: done.auditId,
      alertQueued: done.adminAction,
      next: 'the reconciler checks the hint at its next tick; see order:show',
    });
  },
};
