import { PaymentReviewKindSchema } from '@repo/shared';
import { z } from 'zod';
import type { CardAdminActor } from '../../modules/payments/card-admin.input';
import { reasonsText } from '../../modules/payments/card-pause.service';
import { ReviewService, type ReviewDecision } from '../../modules/payments/review.service';
import { terminalLines, terminalSafe } from '../cli-io';
import { REVIEW_CREDIT_COMMAND } from './review-credit.command';
import { REVIEW_LIST_MAX } from '../../modules/payments/review.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  UsageError,
  actorOf,
  money,
  parse,
  positional,
  report,
  text,
  type CliCommand,
} from './command';

const StatusSchema = z.enum(['OPEN', 'RESOLVED']);

function iso(date: Date | null): string {
  return date === null ? '-' : date.toISOString();
}

const list: CliCommand = {
  name: 'review:list',
  summary: 'list reviews (default: OPEN, oldest first)',
  usage: 'review:list [--status OPEN|RESOLVED] [--kind <kind>] [--card <cardId>] [--limit 1..100]',
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        status: { type: 'string' },
        kind: { type: 'string' },
        card: { type: 'string' },
        limit: { type: 'string' },
      },
      0,
    );
    const status = StatusSchema.safeParse(text(p, 'status') ?? 'OPEN');
    const rawKind = text(p, 'kind');
    const kind = rawKind === undefined ? undefined : PaymentReviewKindSchema.safeParse(rawKind);
    const rawLimit = text(p, 'limit') ?? '50';
    const limit = Number(rawLimit);
    const card = text(p, 'card');
    if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > REVIEW_LIST_MAX) {
      throw new UsageError(`--limit: a whole number 1..${String(REVIEW_LIST_MAX)}`);
    }
    if (!status.success) throw new UsageError('--status: OPEN or RESOLVED');
    if (kind !== undefined && !kind.success) throw new UsageError('--kind: not a review kind');
    const rows = await ctx.app.get(ReviewService).list({
      status: status.data,
      ...(kind === undefined ? {} : { kind: kind.data }),
      ...(card === undefined ? {} : { cardId: card }),
      limit,
    });
    for (const r of rows) {
      const card = r.card === null ? '-' : `${r.card.bank}*${r.card.last4}`;
      ctx.io.out(
        terminalSafe(
          [
            r.id,
            r.kind,
            r.status,
            r.resolution ?? '-',
            iso(r.createdAt),
            card,
            r.bankMessage.direction ?? '-',
            money(r.bankMessage.amountTiyin),
            r.note ?? '-',
          ].join('  '),
        ),
      );
    }
    ctx.io.out(`${String(rows.length)} review(s)`);
  },
};

const show: CliCommand = {
  name: 'review:show',
  summary: 'one review with its bank message, including the raw text',
  usage: 'review:show <reviewId>',
  async run(ctx, argv) {
    const p = parse(argv, {}, 1);
    const { review: r, messagePayment: paid } = await ctx.app
      .get(ReviewService)
      .show(positional(p, 0));
    const m = r.bankMessage;
    report(ctx, {
      id: r.id,
      kind: r.kind,
      status: r.status,
      note: r.note,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt === null ? null : iso(r.resolvedAt),
      resolvedAudit: r.resolvedAuditLog?.id ?? null,
      created: iso(r.createdAt),
      card: r.card === null ? null : `${r.card.id} ${r.card.bank}*${r.card.last4}`,
      intent:
        r.intent === null
          ? null
          : `${r.intent.id} ${r.intent.status} ${money(r.intent.amountTiyin)} user=${r.intent.userId}`,
      // The message's Payment, whichever path made it (the matcher, this or another review).
      payment:
        paid === null
          ? null
          : `${paid.id} ${paid.status} ${money(paid.amountTiyin)} user=${paid.userId} ` +
            `via=${paid.reviewId === null ? 'auto' : paid.reviewId === r.id ? 'this review' : `review ${paid.reviewId}`}`,
      message: m.id,
      source: m.source,
      tgMessageId: m.tgMessageId.toString(),
      tgDate: iso(m.tgDate),
      parseStatus: m.parseStatus,
      rejectReason: m.rejectReason,
      direction: m.direction,
      amount: money(m.amountTiyin),
      last4: m.last4,
      channel: m.channel,
    });
    // The raw text is shown here and nowhere else (docs/05 §7); purged after its retention.
    // Every line is prefixed, so no bank text can pass for a line of this program (I1).
    ctx.io.out('--- bank text ---');
    const raw = m.rawText?.text ?? null;
    if (raw === null) ctx.io.out('(purged)');
    else for (const line of terminalLines(raw)) ctx.io.out(`| ${line}`);
    ctx.io.out('--- end bank text ---');
  },
};

function closing(
  name: string,
  summary: string,
  decide: (
    service: ReviewService,
    id: string,
    reason: string,
    actor: CardAdminActor,
  ) => Promise<ReviewDecision>,
): CliCommand {
  return {
    name,
    summary,
    usage: `${name} <reviewId> ${ACTOR_USAGE}`,
    async run(ctx, argv) {
      const p = parse(argv, ACTOR_OPTIONS, 1);
      const { reason, actor } = actorOf(ctx, p);
      const done = await decide(ctx.app.get(ReviewService), positional(p, 0), reason, actor);
      report(ctx, {
        review: done.reviewId,
        resolution: done.resolution,
        audit: done.auditId,
        autoCreditResumed: done.resumedCardId,
        alertQueued: done.alertQueued,
      });
      // review:accept-chain on a card with another open pause reason (S8 M1).
      const remaining = reasonsText(done.remainingPauseReasons);
      if (remaining !== null) {
        report(ctx, { stillPausedBy: remaining });
        ctx.io.out(
          'auto-credit stays OFF: decide those first, or resume with card:resume <cardId> ' +
            '--confirm-override --reason ... --operator ...',
        );
      }
    },
  };
}

export const REVIEW_COMMANDS: readonly CliCommand[] = [
  list,
  show,
  REVIEW_CREDIT_COMMAND,
  closing('review:ignore', 'close a review: nothing to do with the money', (s, id, r, a) =>
    s.ignore(id, r, a),
  ),
  closing(
    'review:returned-offline',
    'close a review: the transfer was paid back outside the bot',
    (s, id, r, a) => s.returnedOffline(id, r, a),
  ),
  closing(
    'review:accept-chain',
    "accept a CHAIN_BREAK as the card's new chain head and resume auto-credit",
    (s, id, r, a) => s.acceptChain(id, r, a),
  ),
];
