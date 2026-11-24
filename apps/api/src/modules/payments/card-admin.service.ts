import { Inject, Injectable } from '@nestjs/common';
import type { TopupCard, TopupCardStatus } from '@repo/db';
import { assertIntentTransition } from '@repo/shared';
import {
  checkedAuditActor,
  type AuditActor,
  type CheckedAuditActor,
} from '../../common/admin/audit-actor';
import { confirmActorInTx } from '../../common/admin/audit-actor.check';
import { runActorTransaction } from '../../common/admin/admin-transaction';
import { verifyAdminStepUp } from '../../common/admin/step-up';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import type { Db } from '../../infra/prisma/db';
import {
  cardInputError,
  checkedBank,
  checkedCardId,
  checkedHolderName,
  checkedLimit,
  checkedPan,
  checkedReason,
  newVerifyAmountTiyin,
} from './card-admin.input';
import { raiseCardAlerts, writeCardAudit } from './card-admin.audit';
import { CardAdminRepository } from './card-admin.repository';
import { lowersCardLimit, requireCardStepUp } from './card-admin.step-up';
import {
  cardJson as json,
  type AddCardInput,
  type AddedCard,
  type AuditExtra,
  type CardAudit,
  type CardChange,
  type Committed,
} from './card-admin.types';
import { CARD_FULL_PERCENT, receivedUsagePercent, tashkentMonthStart } from './card-capacity';
import { CardPoolRepository } from './card-pool.repository';
import { assertCardTransition } from './card-state';
import { isUniqueViolation } from './db-errors';
import { PaymentsAlerts } from './payments-alerts';

/** A retired (bank, last4) is not reused for this long (docs/05 §2: an assumption, tunable here). */
export const LAST4_REUSE_COOLDOWN_DAYS = 30;
/** The partial unique index on (bank, last4) of live cards (migration p4_wallet_p2p_checks). */
const LIVE_LAST4_INDEX = 'TopupCard_bank_last4_active_key';
const DAY_MS = 86_400_000;

export type {
  AddCardInput,
  AddedCard,
  AuditExtra,
  CardAudit,
  CardChange,
} from './card-admin.types';

/**
 * The owner's card operations (docs/05 §2, §7; D-37 (9)): the owner CLI, and the panel's OWNER
 * pause / resume / limit / retire (S6; card:add is CLI-only). ONE transaction each: the actor
 * re-read (an admin FOR SHARE, S2-6), the card's advisory lock (the one new requests take), the
 * change and its AuditLog row. The audit never holds the PAN or the holder name.
 */
@Injectable()
export class CardAdminService {
  constructor(
    private readonly repo: CardAdminRepository,
    private readonly pool: CardPoolRepository,
    private readonly alerts: PaymentsAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async addCard(input: AddCardInput): Promise<AddedCard> {
    const bank = checkedBank(input.bank);
    const pan = checkedPan(input.pan);
    const holderName = checkedHolderName(input.holderName);
    const limit = checkedLimit('limitTiyin', input.limitTiyin);
    const monthly =
      input.monthlyLimitTiyin === undefined
        ? null
        : checkedLimit('monthlyLimitTiyin', input.monthlyLimitTiyin);
    const audit = this.audit('CARD_ADD', input.reason, input.actor);
    const now = this.clock.now();
    const verifyAmountTiyin = newVerifyAmountTiyin();

    let added: Committed<AddedCard>;
    try {
      added = await runActorTransaction(this.pool, audit.actor, async (tx) => {
        // D-52 r2 (review I-A): the pause lock first, then the pause state (see below).
        await this.repo.lockSecurityPause(tx);
        const block = await this.repo.last4Block(
          tx,
          { bank, last4: pan.slice(-4) },
          now,
          new Date(now.getTime() - LAST4_REUSE_COOLDOWN_DAYS * DAY_MS),
        );
        if (block !== null) throw cardInputError('pan', block);
        // D-52 D2, refined in r2: while a SECURITY pause is open (a new authorization or an
        // empty baseline of the bank-feed account, or a bank-chat anomaly paused ALL cards), a
        // new card is born paused too, with its own SYSTEM CARD_PAUSE row, so auto-credit on it
        // waits for the owner's card:resume like the others. A chain-break pause of another card
        // alone does not. Read under the pause lock: the worker's pause reads its card list
        // under the same lock, so it either sees this card or this read sees its pause.
        // The actor is re-read here, after the pause lock, unlike the AdminUser-first order of
        // the panel's paths: card:add is CLI-only (D-63 (6)), and a CLI actor takes no AdminUser
        // lock, so no lock-order cycle with the panel can form (C-12).
        const who = await confirmActorInTx(tx, audit.actor, now);
        const pause = await this.repo.openSecurityPause(tx);
        const card = await this.repo.createCard(tx, {
          autoCreditPaused: pause !== null,
          bank,
          pan,
          holderName,
          receiveLimitTiyin: limit,
          monthlyLimitTiyin: monthly,
          verifyAmountTiyin,
        });
        const auditId = await writeCardAudit(this.repo, tx, { cardId: card.id, audit, who }, null, {
          ...json(card),
          bank,
          last4: card.last4,
          verifyAmountTiyin: verifyAmountTiyin.toString(),
        });
        if (pause !== null) await this.repo.createBornPausedAudit(tx, card.id, pause);
        return {
          applied: true,
          cardId: card.id,
          status: card.status,
          auditId,
          verifyAmountTiyin,
          autoCreditPaused: card.autoCreditPaused,
        };
      });
    } catch (error) {
      // Two adds of one (bank, last4) at once: the partial unique index keeps only one.
      if (isUniqueViolation(error, LIVE_LAST4_INDEX)) throw cardInputError('pan', 'LIVE_CARD');
      throw error;
    }
    return { ...added, alertQueued: await raiseCardAlerts(this.alerts, added) };
  }

  /**
   * Ordinary: ACTIVE/FULL -> DRAINING (no new requests; issued ones stay payable until their
   * reservation ends, then the worker retires the card). VERIFYING has no requests and retires
   * at once. Emergency (card blocked or untrusted): RETIRED now, its PENDING requests CANCELLED
   * with their pay links dead; money still arriving goes to review.
   */
  async retireCard(
    cardId: string,
    reason: string,
    actor: AuditActor,
    options: { readonly emergency: boolean } = { emergency: false },
  ): Promise<CardChange> {
    const action = options.emergency ? 'CARD_RETIRE_EMERGENCY' : 'CARD_RETIRE';
    const audit = this.audit(action, reason, actor);
    const otpVerified = await verifyAdminStepUp(audit.actor);
    return this.change(cardId, audit.actor, async (tx, card) => {
      // The panel's code is asked for every retire, before any state is looked at.
      const otp = requireCardStepUp(audit.actor, otpVerified, true);
      const target: TopupCardStatus =
        options.emergency || card.status === 'VERIFYING' ? 'RETIRED' : 'DRAINING';
      if (card.status === target || card.status === 'RETIRED') return null;
      assertCardTransition(card.status, target);
      let cancelled = 0;
      if (target === 'RETIRED') {
        assertIntentTransition('PENDING', 'CANCELLED', { actor: 'admin', withinGrace: true });
        cancelled = await this.repo.cancelPendingOn(tx, card.id);
      }
      const updated = await this.repo.updateCard(tx, card.id, {
        status: target,
        ...(target === 'RETIRED' ? { retiredAt: this.clock.now() } : {}),
      });
      return { card: updated, audit, extra: { cancelledIntents: cancelled, ...otp } };
    });
  }

  /**
   * New limits; FULL <-> ACTIVE follows the money RECEIVED against them (D-45: held UNPAID amounts
   * never change the state, they only leave no room for new requests). FULL -> ACTIVE only this
   * way (E-9).
   */
  async setLimit(
    cardId: string,
    limits: { readonly limitTiyin: bigint; readonly monthlyLimitTiyin?: bigint | null },
    reason: string,
    actor: AuditActor,
  ): Promise<CardChange> {
    const limit = checkedLimit('limitTiyin', limits.limitTiyin);
    const monthly =
      limits.monthlyLimitTiyin === undefined || limits.monthlyLimitTiyin === null
        ? limits.monthlyLimitTiyin
        : checkedLimit('monthlyLimitTiyin', limits.monthlyLimitTiyin);
    const audit = this.audit('CARD_LIMIT', reason, actor);
    const otpVerified = await verifyAdminStepUp(audit.actor);
    return this.change(cardId, audit.actor, async (tx, card) => {
      if (card.status === 'RETIRED') throw cardInputError('status', 'RETIRED');
      // Lowering a limit asks the panel's code; the limits are read under the card lock.
      const otp = requireCardStepUp(
        audit.actor,
        otpVerified,
        lowersCardLimit(card, { limitTiyin: limit, monthlyLimitTiyin: monthly }),
      );
      let updated = await this.repo.updateCard(tx, card.id, {
        receiveLimitTiyin: limit,
        ...(monthly === undefined ? {} : { monthlyLimitTiyin: monthly }),
      });
      const now = this.clock.now();
      const [totals] = await this.pool.cardTotals(tx, {
        now,
        monthStart: tashkentMonthStart(now),
        statuses: [updated.status],
        autoCreditOnly: false,
        cardId: card.id,
      });
      const full = totals === undefined || receivedUsagePercent(totals) >= CARD_FULL_PERCENT;
      const next =
        updated.status === 'FULL' && !full
          ? 'ACTIVE'
          : updated.status === 'ACTIVE' && full
            ? 'FULL'
            : null;
      if (next !== null) {
        assertCardTransition(updated.status, next);
        updated = await this.repo.updateCard(tx, card.id, { status: next });
      }
      return { card: updated, audit, extra: otp };
    });
  }

  /**
   * Auto-credit off or on (the CLI goes through CardPauseService, which checks the open pause
   * reviews before a resume). `check` runs under the card lock before anything is written.
   */
  setPaused(
    cardId: string,
    paused: boolean,
    audit: CardAudit,
    check: (tx: Db) => Promise<AuditExtra> = () => Promise.resolve({}),
  ): Promise<CardChange> {
    return this.change(cardId, audit.actor, async (tx, card) => {
      // A retired card takes no money and never comes back: pausing it is a mistake, not a no-op.
      if (card.status === 'RETIRED') throw cardInputError('status', 'RETIRED');
      if (card.autoCreditPaused === paused) {
        if (!paused) return null;
        // The worker may have paused it already: the owner's own card:pause is still written,
        // so a later review:accept-chain keeps the card paused for it (S8 R1).
        return { card, audit, extra: { ...(await check(tx)), alreadyPaused: true } };
      }
      const extra = await check(tx);
      const updated = await this.repo.updateCard(tx, card.id, { autoCreditPaused: paused });
      return { card: updated, audit, extra };
    });
  }

  // Input checked BEFORE the tx (a refusal writes nothing); then lock, read, mutate, audit.
  private async change(
    rawCardId: string,
    actor: CheckedAuditActor,
    mutate: (
      tx: Db,
      card: TopupCard,
    ) => Promise<{ card: TopupCard; audit: CardAudit; extra: AuditExtra } | null>,
  ): Promise<CardChange> {
    const cardId = checkedCardId(rawCardId);
    const result = await runActorTransaction<Committed<CardChange>>(
      this.pool,
      actor,
      async (tx) => {
        const who = await confirmActorInTx(tx, actor, this.clock.now());
        await this.pool.lockCard(tx, cardId);
        const card = await this.repo.findCard(tx, cardId);
        if (card === null) throw new AppError('NOT_FOUND');
        const changed = await mutate(tx, card);
        if (changed === null) {
          return { applied: false, cardId, status: card.status, auditId: null };
        }
        const row = { cardId, audit: changed.audit, who };
        const auditId = await writeCardAudit(this.repo, tx, row, json(card), {
          ...json(changed.card),
          ...changed.extra,
        });
        return { applied: true, cardId, status: changed.card.status, auditId };
      },
    );
    return { ...result, alertQueued: await raiseCardAlerts(this.alerts, result) };
  }

  audit(action: string, reason: string, actor: AuditActor): CardAudit {
    return { action, reason: checkedReason(reason), actor: checkedAuditActor(actor) };
  }
}
