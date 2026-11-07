import { Inject, Injectable } from '@nestjs/common';
import type { TopupCard, TopupCardStatus } from '@repo/db';
import { assertIntentTransition } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import type { Db } from '../../infra/prisma/db';
import {
  cardInputError,
  actorAfter,
  checkedActor,
  checkedBank,
  checkedCardId,
  checkedHolderName,
  checkedLimit,
  checkedPan,
  checkedReason,
  newVerifyAmountTiyin,
  type CardAdminActor,
} from './card-admin.input';
import { CardAdminRepository } from './card-admin.repository';
import type {
  AddCardInput,
  AddedCard,
  AuditExtra,
  CardAudit,
  CardChange,
  Committed,
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

const json = (card: TopupCard) => ({
  status: card.status,
  receiveLimitTiyin: card.receiveLimitTiyin.toString(),
  monthlyLimitTiyin: card.monthlyLimitTiyin?.toString() ?? null,
  autoCreditPaused: card.autoCreditPaused,
});

/**
 * The owner's card operations (docs/05 §2, §7; D-37 (9)). Not reachable over HTTP: the owner
 * CLI on the VPS calls them. Each is ONE transaction holding the card's advisory lock (the same
 * lock new requests take, so a request can never land on a card that is being retired or
 * paused) and writes its AuditLog row in it. The audit never holds the PAN or the holder name:
 * bank, last4 and the changed fields are enough to tell what happened.
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
      added = await this.pool.transaction(async (tx) => {
        const block = await this.repo.last4Block(
          tx,
          { bank, last4: pan.slice(-4) },
          now,
          new Date(now.getTime() - LAST4_REUSE_COOLDOWN_DAYS * DAY_MS),
        );
        if (block !== null) throw cardInputError('pan', block);
        const card = await this.repo.createCard(tx, {
          bank,
          pan,
          holderName,
          receiveLimitTiyin: limit,
          monthlyLimitTiyin: monthly,
          verifyAmountTiyin,
        });
        const auditId = await this.writeAudit(tx, card.id, audit, null, {
          ...json(card),
          bank,
          last4: card.last4,
          verifyAmountTiyin: verifyAmountTiyin.toString(),
        });
        return { applied: true, cardId: card.id, status: card.status, auditId, verifyAmountTiyin };
      });
    } catch (error) {
      // Two adds of one (bank, last4) at once: the partial unique index keeps only one.
      if (isUniqueViolation(error, LIVE_LAST4_INDEX)) throw cardInputError('pan', 'LIVE_CARD');
      throw error;
    }
    return { ...added, alertQueued: await this.afterCommit(added) };
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
    actor: CardAdminActor,
    options: { readonly emergency: boolean } = { emergency: false },
  ): Promise<CardChange> {
    const audit = this.audit(
      options.emergency ? 'CARD_RETIRE_EMERGENCY' : 'CARD_RETIRE',
      reason,
      actor,
    );
    return this.change(cardId, async (tx, card) => {
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
      return { card: updated, audit, extra: { cancelledIntents: cancelled } };
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
    actor: CardAdminActor,
  ): Promise<CardChange> {
    const limit = checkedLimit('limitTiyin', limits.limitTiyin);
    const monthly =
      limits.monthlyLimitTiyin === undefined || limits.monthlyLimitTiyin === null
        ? limits.monthlyLimitTiyin
        : checkedLimit('monthlyLimitTiyin', limits.monthlyLimitTiyin);
    const audit = this.audit('CARD_LIMIT', reason, actor);
    return this.change(cardId, async (tx, card) => {
      if (card.status === 'RETIRED') throw cardInputError('status', 'RETIRED');
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
      return { card: updated, audit, extra: {} };
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
    return this.change(cardId, async (tx, card) => {
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

  // Validates input BEFORE the transaction (a refusal writes nothing), then: card lock, read,
  // mutate, audit, commit, alerts.
  private async change(
    rawCardId: string,
    mutate: (
      tx: Db,
      card: TopupCard,
    ) => Promise<{ card: TopupCard; audit: CardAudit; extra: AuditExtra } | null>,
  ): Promise<CardChange> {
    const cardId = checkedCardId(rawCardId);
    const result = await this.pool.transaction(async (tx): Promise<Committed<CardChange>> => {
      await this.pool.lockCard(tx, cardId);
      const card = await this.repo.findCard(tx, cardId);
      if (card === null) throw new AppError('NOT_FOUND');
      const changed = await mutate(tx, card);
      if (changed === null) {
        return { applied: false, cardId, status: card.status, auditId: null };
      }
      const auditId = await this.writeAudit(tx, cardId, changed.audit, json(card), {
        ...json(changed.card),
        ...changed.extra,
      });
      return { applied: true, cardId, status: changed.card.status, auditId };
    });
    return { ...result, alertQueued: await this.afterCommit(result) };
  }

  audit(action: string, reason: string, actor: CardAdminActor): CardAudit {
    return { action, reason: checkedReason(reason), actor: checkedActor(actor) };
  }

  private writeAudit(
    tx: Db,
    cardId: string,
    audit: CardAudit,
    before: ReturnType<typeof json> | null,
    after: Record<string, string | number | boolean | null>,
  ): Promise<string> {
    return this.repo.createAudit(tx, {
      ip: audit.actor.ip,
      action: audit.action,
      targetId: cardId,
      before,
      after: { ...after, ...actorAfter(audit.actor) },
      reason: audit.reason,
    });
  }

  // Best effort (the change is committed): the CLI shows alertQueued=false so the owner knows
  // the bot did not hear about it.
  private async afterCommit(change: Committed<CardChange>): Promise<boolean> {
    if (!change.applied || change.auditId === null) return false;
    const jobs = [await this.alerts.raise('adminAction', change.auditId)];
    if (change.status === 'DRAINING')
      jobs.push(await this.alerts.raise('cardDraining', change.cardId));
    return jobs.every((jobId) => jobId !== null);
  }
}
