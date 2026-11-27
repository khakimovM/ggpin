import { Inject, Injectable } from '@nestjs/common';
import {
  MANUAL_FX_SOURCE,
  ManualFxPairSchema,
  ManualFxRateSchema,
  derivedFxSource,
  type ManualFxPair,
} from '@repo/shared';
import { checkedReason, validationError } from '../../common/admin/admin-input';
import type { OtpAnswer } from '../../common/admin/owner-otp/owner-otp';
import { OwnerOtpVerifier } from '../../common/admin/owner-otp/owner-otp.verifier';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { OrderAdminEffects } from '../orders/admin/order-admin-effects';
import {
  OPERATOR_CHANNEL,
  assertOwnerChannel,
  checkedActor,
  type OperatorChannel,
} from '../orders/admin/operator-channel';
import { FxAdminRepository, type FxRow } from './fx-admin.repository';
import { planFx, type FxPlan } from './fx-admin.plan';

export interface FxSetRequest {
  readonly pair: string;
  readonly rate: string;
}

export interface FxSetInput extends FxSetRequest {
  readonly reason: string;
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
  /** The rate typed a second time; with the owner's code when the plan has flags. */
  readonly confirmRate?: string;
  readonly otp?: OtpAnswer;
}

export interface FxSetOutcome {
  readonly auditId: string;
  readonly row: FxRow;
  readonly derived: FxRow | null;
  readonly derivedSkip: string | null;
  readonly otpVerified: boolean;
  readonly adminAction: boolean;
}

/** What the owner's code for `fx:set` names: the pair and the exact rate. */
export function fxOtpTarget(pair: ManualFxPair, rate: string): string {
  return `fx ${pair} ${rate}`;
}

/**
 * `fx:set` (plan Q4 = (a), D-56 (3), D-35 (a), (b), (e)): the owner's manual rate, source
 * `manual`, until a real exchange source exists. Bounds refuse a typo outright; a move of more
 * than 10% from any manual row of the last 24 h (or no such row) needs the re-typed rate and the
 * owner's code, bound to the pair, the rate and the flags. In ONE transaction, serialised by an
 * advisory lock and re-planned under it: the row, the derived TON_UZS (when the other pair's
 * manual rate is fresh) and the AuditLog (FX_SET). The adminAction alert follows the commit.
 * Not reachable over HTTP (CLI channel only).
 */
@Injectable()
export class FxAdminService {
  constructor(
    private readonly repo: FxAdminRepository,
    private readonly otp: OwnerOtpVerifier,
    private readonly effects: OrderAdminEffects,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OPERATOR_CHANNEL) private readonly channel: OperatorChannel,
  ) {}

  preview(request: FxSetRequest, now: Date = this.clock.now()): Promise<FxPlan> {
    assertOwnerChannel(this.channel);
    return planFx(this.repo, this.repo.client, { ...checkedPair(request), now });
  }

  async set(input: FxSetInput): Promise<FxSetOutcome> {
    assertOwnerChannel(this.channel);
    const reason = checkedReason(input.reason);
    const actor = checkedActor(input);
    const now = this.clock.now();
    const { pair, rate } = checkedPair(input);
    const plan = await this.preview({ pair, rate }, now);
    const target = fxOtpTarget(pair, rate);
    const confirmed = input.confirmRate === rate ? 0n : undefined;
    if (input.otp !== undefined && confirmed === undefined) throw validationError('confirmRate');
    const otpVerified = await this.otp.verifyIfGiven(
      input.otp,
      confirmed,
      'fx:set',
      target,
      plan.flags,
    );
    requireCode(plan.flags, input.confirmRate === rate, otpVerified);

    const written = await this.repo.transaction(async (tx) => {
      await this.repo.lockFxSet(tx);
      const fresh = await planFx(this.repo, tx, { pair, rate, now });
      // The history moved after the code was sent: it confirmed other flags.
      if (otpVerified && fresh.flags !== plan.flags) throw validationError('otp', 'OTP_MISMATCH');
      requireCode(fresh.flags, input.confirmRate === rate, otpVerified);
      const row = await this.repo.insert(tx, { pair, rate, source: MANUAL_FX_SOURCE });
      let derived: FxRow | null = null;
      if (fresh.derived !== null) {
        const tonUsdtId = pair === 'TON_USDT' ? row.id : fresh.derived.other.id;
        const usdtUzsId = pair === 'USDT_UZS' ? row.id : fresh.derived.other.id;
        derived = await this.repo.insert(tx, {
          pair: 'TON_UZS',
          rate: fresh.derived.rate,
          source: derivedFxSource(tonUsdtId, usdtUzsId),
        });
      }
      const audit = await this.repo.createAudit(tx, {
        targetId: row.id,
        before: {
          previous:
            fresh.previous === null
              ? null
              : { id: fresh.previous.id, rate: fresh.previous.rate, source: fresh.previous.source },
        },
        after: {
          pair,
          rate,
          source: MANUAL_FX_SOURCE,
          derived: derived === null ? null : { id: derived.id, rate: derived.rate },
          derivedSkip: fresh.derivedSkip,
          flags: fresh.flags,
          operator: actor.operator,
          osUser: actor.osUser,
          otpVerified,
        },
        reason,
        ip: actor.ip,
      });
      return { auditId: audit.id, row, derived, derivedSkip: fresh.derivedSkip };
    });
    const adminAction = await this.effects.adminAction(written.auditId);
    return { ...written, otpVerified, adminAction };
  }
}

function checkedPair(request: FxSetRequest): { pair: ManualFxPair; rate: string } {
  const pair = ManualFxPairSchema.safeParse(request.pair);
  if (!pair.success) throw validationError('pair');
  const rate = ManualFxRateSchema.safeParse(request.rate);
  if (!rate.success) throw validationError('rate');
  return { pair: pair.data, rate: rate.data };
}

/** Flags mean the owner confirms: the rate re-typed and the code verified (D-35 (e)). */
function requireCode(flags: string, retyped: boolean, otpVerified: boolean): void {
  if (flags === '') return;
  if (!retyped) throw validationError('confirmRate');
  if (!otpVerified) throw validationError('otp', 'OTP_REQUIRED');
}
