import { MANUAL_FX_PAIRS } from '@repo/shared';
import type { OtpAnswer } from '../../common/admin/owner-otp/owner-otp';
import { OwnerOtpIssuer } from '../../common/admin/owner-otp/owner-otp.issuer';
import { FxAdminService, fxOtpTarget } from '../../modules/fx-admin/fx-admin.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  actorOf,
  parse,
  report,
  required,
  type CliCommand,
} from './command';

const USAGE =
  `fx:set --pair <${MANUAL_FX_PAIRS.join('|')}> --rate <decimal> ${ACTOR_USAGE}\n` +
  "   The owner's manual rate (source manual) until a real exchange source exists (D-35, D-56).\n" +
  '   Outside the fixed bounds it is refused. A move of more than 10% from any manual rate of the\n' +
  "   last 24 h, or no manual rate in 24 h, needs the rate re-typed and the owner's code.\n" +
  "   TON_UZS is derived (TON_USDT x USDT_UZS, rounded up) when the other pair's manual rate is\n" +
  '   fresh (30 min). Quotes stop when the rates are 30 minutes old: set them again.';

/**
 * fx:set (plan Q4 = (a)). The plan (bounds, previous rate, derived TON_UZS, jump flags) is shown
 * first; with flags the rate is re-typed and the owner's code is asked (bound to the pair, the
 * rate and the flags; the amount is 0), then ONE transaction writes the rows and the AuditLog.
 */
export const FX_SET_COMMAND: CliCommand = {
  name: 'fx:set',
  summary: "set the owner's manual FX rate (USDT_UZS or TON_USDT; TON_UZS is derived)",
  usage: USAGE,
  async run(ctx, argv) {
    const p = parse(
      argv,
      { ...ACTOR_OPTIONS, pair: { type: 'string' }, rate: { type: 'string' } },
      0,
    );
    const { reason, actor } = actorOf(ctx, p);
    const pair = required(p, 'pair');
    const rate = required(p, 'rate');
    const fx = ctx.app.get(FxAdminService);
    const plan = await fx.preview({ pair, rate });
    report(ctx, {
      pair: plan.pair,
      rate: plan.rate,
      previous:
        plan.previous === null
          ? null
          : `${plan.previous.rate} (${plan.previous.source}, ${plan.previous.createdAt.toISOString()})`,
      derivedTonUzs: plan.derived?.rate ?? null,
      derivedSkipped: plan.derivedSkip,
      confirms: plan.flags === '' ? '-' : plan.flags,
    });
    let confirmRate: string | undefined;
    let otp: OtpAnswer | undefined;
    let done = (): Promise<void> => Promise.resolve();
    try {
      if (plan.flags !== '') {
        confirmRate = (
          await ctx.io.prompt("This rate needs the owner's code. Re-type the rate to confirm: ")
        ).trim();
        if (confirmRate === plan.rate) {
          const issuer = ctx.app.get(OwnerOtpIssuer);
          const challenge = await issuer.issue({
            action: 'fx:set',
            amountTiyin: 0n,
            target: fxOtpTarget(plan.pair, plan.rate),
            flags: plan.flags,
          });
          done = () => issuer.discard(challenge.challengeId);
          ctx.io.out(
            `A one-time code was sent to the owner's Telegram (valid ${String(challenge.expiresInSec / 60)} min).`,
          );
          const code = (await ctx.io.secret('Code from the bot (not shown): ')).trim();
          otp = { challengeId: challenge.challengeId, code };
        }
      }
      const set = await fx.set({
        pair,
        rate,
        reason,
        operator: actor.operator,
        ip: actor.ip ?? null,
        osUser: actor.osUser ?? null,
        ...(confirmRate === undefined ? {} : { confirmRate }),
        ...(otp === undefined ? {} : { otp }),
      });
      report(ctx, {
        applied: true,
        fxRate: set.row.id,
        derived: set.derived === null ? null : `${set.derived.id} TON_UZS ${set.derived.rate}`,
        audit: set.auditId,
        otpVerified: set.otpVerified,
        alertQueued: set.adminAction,
      });
    } finally {
      await done();
    }
  },
};

export const FX_COMMANDS: readonly CliCommand[] = [FX_SET_COMMAND];
