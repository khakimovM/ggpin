import { checkedBank, checkedHolderName } from '../../modules/payments/card-admin.input';
import { CardAdminService, type CardChange } from '../../modules/payments/card-admin.service';
import { isPauseDecision } from '../../modules/payments/card-pause.repository';
import { CardPauseService, reasonsText } from '../../modules/payments/card-pause.service';
import { CardListing } from '../card-listing';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  actorOf,
  flag,
  money,
  parse,
  positional,
  report,
  required,
  somAmount,
  text,
  type CliCommand,
  type CliContext,
} from './command';

// Receiving-card commands (docs/05 §2, §7). Output and logs name a card by id, bank and last4
// only: the PAN is typed once into card:add and never printed back.

function changed(ctx: CliContext, change: CardChange): void {
  report(ctx, {
    card: change.cardId,
    applied: change.applied,
    status: change.status,
    audit: change.auditId,
    alertQueued: change.alertQueued,
  });
}

const add: CliCommand = {
  name: 'card:add',
  summary: 'add a receiving card (VERIFYING until its test transfer arrives)',
  usage:
    `card:add --bank HUMO|UZCARD --limit <so'm> [--monthly-limit <so'm>] ${ACTOR_USAGE}` +
    '   (the holder name and the card number are then typed, not shown, so they stay out of ' +
    'the shell history, the npm log and the terminal)',
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        bank: { type: 'string' },
        limit: { type: 'string' },
        'monthly-limit': { type: 'string' },
      },
      0,
    );
    const monthly = text(p, 'monthly-limit');
    const { reason, actor } = actorOf(ctx, p);
    // Everything else is checked before the card details are asked for (n7).
    const bank = checkedBank(required(p, 'bank'));
    const limitTiyin = somAmount(required(p, 'limit'), 'limit');
    const monthlyLimitTiyin =
      monthly === undefined ? undefined : somAmount(monthly, 'monthly-limit');
    const holderName = checkedHolderName(await ctx.io.secret('Holder name as on the card: '));
    const pan = (await ctx.io.secret('Card number (16 digits): ')).trim();
    const added = await ctx.app.get(CardAdminService).addCard({
      bank,
      pan,
      holderName,
      limitTiyin,
      ...(monthlyLimitTiyin === undefined ? {} : { monthlyLimitTiyin }),
      reason,
      actor,
    });
    changed(ctx, added);
    // The owner sends exactly this to the card; its bank message makes the card ACTIVE.
    report(ctx, {
      verifyAmount: money(added.verifyAmountTiyin),
      autoCreditPaused: added.autoCreditPaused,
    });
    if (added.autoCreditPaused) {
      // D-52 D2/r2 I-B: born under an open security pause (a new authorization of the bank-feed
      // account, an empty baseline or a bank-chat anomaly). A verify transfer to a paused card
      // goes to review instead of activating it.
      ctx.io.out(
        'warning: the card is born paused: a security pause is open on the other cards. Check ' +
          'Telegram -> Devices of the bank-feed account (docs/05 runbook), then run ' +
          `card:resume ${added.cardId} BEFORE sending the verify transfer.`,
      );
    }
  },
};

const list: CliCommand = {
  name: 'card:list',
  summary: 'receiving cards with status, limits and received money (no card numbers)',
  usage: 'card:list [--all]   (default: cards that are not RETIRED)',
  async run(ctx, argv) {
    const p = parse(argv, { all: { type: 'boolean' } }, 0);
    const rows = await ctx.app.get(CardListing).list(p.values['all'] === true);
    for (const row of rows) ctx.io.out(row);
    ctx.io.out(`${String(rows.length)} card(s)`);
  },
};

const retire: CliCommand = {
  name: 'card:retire',
  summary: 'stop a card: DRAINING (default) or, with --emergency, RETIRED now',
  usage: `card:retire <cardId> [--emergency] ${ACTOR_USAGE}`,
  async run(ctx, argv) {
    const p = parse(argv, { ...ACTOR_OPTIONS, emergency: { type: 'boolean' } }, 1);
    const { reason, actor } = actorOf(ctx, p);
    changed(
      ctx,
      await ctx.app
        .get(CardAdminService)
        .retireCard(positional(p, 0), reason, actor, { emergency: p.values['emergency'] === true }),
    );
  },
};

const limit: CliCommand = {
  name: 'card:limit',
  summary: 'set the lifetime (and optionally monthly) receive limit of a card',
  usage: `card:limit <cardId> --limit <so'm> [--monthly-limit <so'm> | --no-monthly-limit] ${ACTOR_USAGE}`,
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        limit: { type: 'string' },
        'monthly-limit': { type: 'string' },
        'no-monthly-limit': { type: 'boolean' },
      },
      1,
    );
    const monthly = text(p, 'monthly-limit');
    const clear = p.values['no-monthly-limit'] === true;
    const { reason, actor } = actorOf(ctx, p);
    const limits = {
      limitTiyin: somAmount(required(p, 'limit'), 'limit'),
      ...(clear
        ? { monthlyLimitTiyin: null }
        : monthly === undefined
          ? {}
          : { monthlyLimitTiyin: somAmount(monthly, 'monthly-limit') }),
    };
    changed(
      ctx,
      await ctx.app.get(CardAdminService).setLimit(positional(p, 0), limits, reason, actor),
    );
  },
};

const pause: CliCommand = {
  name: 'card:pause',
  summary: 'stop auto-credit on a card (money goes to review)',
  usage: `card:pause <cardId> ${ACTOR_USAGE}`,
  async run(ctx, argv) {
    const p = parse(argv, ACTOR_OPTIONS, 1);
    const { reason, actor } = actorOf(ctx, p);
    changed(
      ctx,
      await ctx.app.get(CardPauseService).pauseAutoCredit(positional(p, 0), reason, actor),
    );
  },
};

const resume: CliCommand = {
  name: 'card:resume',
  summary: 'resume auto-credit on a card (lists the open pause reasons first)',
  usage:
    `card:resume <cardId> [--confirm-override] ${ACTOR_USAGE}` +
    '   (--confirm-override: resume although a chain break, integrity or failure review is open; ' +
    'a bare flag, no value; wallet:adjust takes --confirm-override=<set> instead)',
  async run(ctx, argv) {
    const p = parse(argv, { ...ACTOR_OPTIONS, 'confirm-override': { type: 'boolean' } }, 1);
    const { reason, actor } = actorOf(ctx, p);
    const id = positional(p, 0);
    const pauses = ctx.app.get(CardPauseService);
    const open = (await pauses.openReasons(id)).filter((r) => !isPauseDecision(r));
    if (open.length > 0) {
      report(ctx, { openPauseReviews: reasonsText(open) });
      ctx.io.out(
        'decide those reviews first (review:show <id>), or resume with --confirm-override',
      );
    }
    const others = await pauses.otherPausedCount(id);
    if (others > 0) {
      // D-52 D2/r2: several paused cards usually mean the all-cards security pause (a new
      // authorization or an empty baseline of the bank-feed account, or a bank-chat anomaly):
      // each card is resumed on its own, after the account was checked.
      ctx.io.out(
        `warning: ${String(others)} other card(s) are paused too (the all-cards security pause ` +
          'after a new authorization or a bank-chat anomaly?). Check Telegram -> Devices of the ' +
          'bank-feed account and the bot chats first (docs/05 runbook), then resume each card.',
      );
    }
    const override = flag(p, 'confirm-override');
    changed(ctx, await pauses.resumeAutoCredit(id, reason, actor, { confirmOverride: override }));
  },
};

export const CARD_COMMANDS: readonly CliCommand[] = [add, list, retire, limit, pause, resume];
