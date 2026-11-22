import { Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_OTP_NOT_REQUIRED_ERROR,
  adminCodeIssueDecision,
  roleHas,
  type AdminConfirmationBody,
  type AdminConfirmationResponse,
  type OtpCheckInput,
} from '@repo/shared';
import { stepUpFlagList } from '../../../common/admin/step-up';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { lowersCardLimit } from '../../payments/card-admin.step-up';
import { CardPauseService } from '../../payments/card-pause.service';
import { creditOtpFlags } from '../../payments/review-credit.checks';
import { ReviewCreditService } from '../../payments/review-credit.service';
import { adjustOtpFlags } from '../../wallet/wallet-admin.input';
import { WalletAdminService } from '../../wallet/wallet-admin.service';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminPaymentsReadService } from '../payments/admin-payments-read.service';
import { adminWriteError } from '../write/admin-write-error';
import { AdminOtpIssuer, type AdminOtpSubjectRef } from './admin-otp.issuer';

const cardRef = (card: { readonly bank: string; readonly last4: string }) => ({
  bank: card.bank,
  last4: card.last4,
});

/** What the server read for one confirmation: the code rule's input, the binding's flags, and
 * what the code message shows. */
interface ServerView {
  readonly otp: OtpCheckInput;
  readonly flags: readonly string[];
  readonly subject: AdminOtpSubjectRef;
}

/**
 * `POST /admin/confirmations` (docs/04 «Tasdiq kodi — POST /admin/confirmations», SA-M1): a code
 * only for an action this admin may perform now and that needs one now, decided from the
 * server's own reads (never the client's amounts). The flags are computed with the very functions
 * the action uses, so the two bindings agree. Actions whose routes are not served yet (orders,
 * fx, admins: later slices) are `404` like their routes. Writes no AuditLog row (N8).
 */
@Injectable()
export class AdminConfirmService {
  constructor(
    private readonly issuer: AdminOtpIssuer,
    private readonly wallet: WalletAdminService,
    private readonly credits: ReviewCreditService,
    private readonly pauses: CardPauseService,
    private readonly cards: AdminPaymentsReadService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_CONFIRM_THRESHOLD_TIYIN'>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    principal: AdminPrincipal,
    body: AdminConfirmationBody,
  ): Promise<AdminConfirmationResponse> {
    const role = principal.admin.role;
    // The role first (C-1 / SA-S6-4): a role that may not perform the action learns nothing about
    // the target's state. The order-context part of adminMayPerform (OPERATOR's amount limit)
    // needs the order read and runs in adminCodeIssueDecision below.
    if (!roleHas(role, 'confirmations.create') || !roleHas(role, body.action)) {
      throw new AppError('NOT_FOUND');
    }
    try {
      const view = await this.serverView(principal, body);
      const decision = adminCodeIssueDecision(role, body.action, { otp: view.otp });
      if (decision === 'NOT_FOUND') throw new AppError('NOT_FOUND');
      if (decision === 'NOT_REQUIRED') {
        throw new AppError('VALIDATION_ERROR', { fields: [ADMIN_OTP_NOT_REQUIRED_ERROR.field] });
      }
      return await this.issuer.issue({
        admin: principal.admin,
        sessionId: principal.sessionId,
        body,
        serverFlags: view.flags,
        subject: view.subject,
        now: this.clock.now(),
      });
    } catch (error) {
      // The services' refusals in the admin vocabulary (SA-S6-5): fields[{ path, code }].
      throw adminWriteError(error);
    }
  }

  private async serverView(
    principal: AdminPrincipal,
    body: AdminConfirmationBody,
  ): Promise<ServerView> {
    const thresholdTiyin = this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    const adminId = principal.admin.id;
    const now = this.clock.now();
    switch (body.action) {
      case 'users.adjustWallet': {
        // An unknown user gets no code (C-10 a), nor the admin's own account (SA-S6-9).
        await this.wallet.confirmTarget(adminId, body.targetId);
        // The amount IS the request's (signed); the rule needs its sign and size only.
        const amountTiyin = BigInt(body.amountTiyin);
        const recent = await this.wallet.recentFor(body.targetId, amountTiyin);
        const override = body.confirmOverrideSet !== undefined;
        const budget =
          amountTiyin < 0n ? await this.wallet.codelessFlags(adminId, amountTiyin, now) : [];
        return {
          otp: { amountTiyin, thresholdTiyin, codelessBudgetExceeded: budget.length > 0 },
          flags: [...stepUpFlagList(adjustOtpFlags(recent, override)), ...budget],
          subject: { amount: { tiyin: amountTiyin, signed: true }, userId: body.targetId },
        };
      }
      case 'payments.reverse': {
        // The amount the ledger's TOPUP credited: what the reversal takes back (C-10 b).
        const payment = await this.wallet.payment(body.targetId);
        const amountTiyin = payment.amountTiyin;
        const budget = await this.wallet.codelessFlags(adminId, amountTiyin, now);
        return {
          otp: { amountTiyin, thresholdTiyin, codelessBudgetExceeded: budget.length > 0 },
          flags: budget,
          subject: { amount: { tiyin: -amountTiyin, signed: true }, userId: payment.userId },
        };
      }
      case 'payments.reviewCredit': {
        const target =
          body.intentId !== undefined ? { intentId: body.intentId } : { userId: body.userId ?? '' };
        const preview = await this.credits.preview(body.targetId, target);
        await this.wallet.confirmTarget(adminId, preview.userId);
        const given = { override: body.confirmOverride, bankVerified: body.bankVerified };
        return {
          otp: { amountTiyin: preview.amountTiyin, thresholdTiyin },
          flags: stepUpFlagList(creditOtpFlags(preview.user, given)),
          subject: { amount: { tiyin: preview.amountTiyin, signed: true }, userId: preview.userId },
        };
      }
      case 'cards.resume': {
        const card = await this.cards.card(body.targetId);
        const ruleRequiresCode = await this.pauses.liftsSecurityPause(body.targetId);
        return {
          otp: { thresholdTiyin, ruleRequiresCode },
          flags: [],
          subject: { card: cardRef(card) },
        };
      }
      case 'cards.retire': {
        const card = await this.cards.card(body.targetId);
        return { otp: { thresholdTiyin }, flags: [], subject: { card: cardRef(card) } };
      }
      case 'cards.limit': {
        const card = await this.cards.card(body.targetId);
        const monthly = body.monthlyLimitTiyin;
        const ruleRequiresCode = lowersCardLimit(
          {
            receiveLimitTiyin: BigInt(card.receiveLimitTiyin),
            monthlyLimitTiyin:
              card.monthlyLimitTiyin === null ? null : BigInt(card.monthlyLimitTiyin),
          },
          {
            limitTiyin: BigInt(body.receiveLimitTiyin),
            ...(monthly === undefined
              ? {}
              : { monthlyLimitTiyin: monthly === null ? null : BigInt(monthly) }),
          },
        );
        const amount = { tiyin: BigInt(body.receiveLimitTiyin), signed: false };
        return {
          otp: { thresholdTiyin, ruleRequiresCode },
          flags: [],
          subject: { amount, card: cardRef(card) },
        };
      }
      default:
        // Not served in this slice: the same 404 as the action's own (absent) route.
        throw new AppError('NOT_FOUND');
    }
  }
}
