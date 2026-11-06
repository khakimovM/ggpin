import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  TOPUP_PROVIDER,
  assertIntentTransition,
  buildPayLink,
  type CancelTopupIntentResponse,
  type CreateTopupIntentBody,
  type IntentListQuery,
  type PayLinkResponse,
  type TopupIntent,
  type TopupIntentCreated,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { BankFeedHealth } from './bank-feed-health';
import { CardPoolService, IntentInsertRace } from './card-pool.service';
import { CardReservedAlert } from './card-reserved-alert';
import { toTopupIntent, toTopupIntentCreated } from './entities/intent.mapper';
import { generatePayToken, hashPayToken } from './pay-token';
import {
  TopupIntentsRepository,
  type IntentOwner,
  type IntentWithCard,
} from './topup-intents.repository';
import { TopupLimits } from './topup-limits';

/** Same body = same hash; key order and the absent `bank` are normalised. */
export function topupRequestHash(body: CreateTopupIntentBody): string {
  const canonical = JSON.stringify([
    body.provider,
    body.purpose,
    body.amountTiyin,
    body.bank ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const SYSTEM = { actor: 'system', withinGrace: true } as const;

/**
 * Top-up requests (docs/04 "To‘lovlar"). `POST /payments/intents` checks, in the contract's
 * order: request rate (TopupCreateGuard, before validation) -> body (pipe) -> idempotency ->
 * one PENDING -> 3 unpaid reservations -> amount range and daily caps -> listener heartbeat ->
 * card capacity. Nothing is written unless every check passes; the plain pay token exists only
 * in the response.
 */
@Injectable()
export class TopupIntentsService {
  constructor(
    private readonly repo: TopupIntentsRepository,
    private readonly limits: TopupLimits,
    private readonly cards: CardPoolService,
    private readonly bankFeed: BankFeedHealth,
    private readonly reservedAlert: CardReservedAlert,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    userId: string,
    idempotencyKey: string,
    body: CreateTopupIntentBody,
  ): Promise<TopupIntentCreated> {
    const now = this.clock.now();
    const requestHash = topupRequestHash(body);
    const owner = await this.repo.findOwner(userId);
    if (owner === null) throw new AppError('UNAUTHORIZED');
    const replayOf = async (): Promise<TopupIntentCreated | null> => {
      const known = await this.repo.findByKey(userId, idempotencyKey);
      return known === null ? null : this.replay(known, requestHash, owner.locale, now);
    };

    // A lost INSERT race (same user, at the same moment) is resolved by reading the winner: the
    // same key answers as its replay, a PENDING one is the 409. If the winner is already gone
    // (paid, cancelled or expired between the INSERT and the read), the whole request is tried
    // once more; a second loss is 503, never a raw 500.
    for (let attempt = 1; ; attempt += 1) {
      const replayed = await replayOf();
      if (replayed !== null) return replayed;
      try {
        return await this.createOnce(owner, idempotencyKey, requestHash, body, now);
      } catch (error) {
        if (!(error instanceof IntentInsertRace)) throw error;
        const raced = await replayOf();
        if (raced !== null) return raced;
        await this.refusePending(userId, idempotencyKey, now);
        if (attempt === 2) throw new AppError('PAYMENT_METHOD_UNAVAILABLE');
      }
    }
  }

  async get(userId: string, intentId: string): Promise<TopupIntent> {
    await this.expireOverdue(this.clock.now(), { userId, id: intentId });
    const row = await this.repo.findOwn(userId, intentId);
    if (row === null) throw new AppError('NOT_FOUND');
    return toTopupIntent(row);
  }

  async list(userId: string, query: IntentListQuery): Promise<TopupIntent[]> {
    await this.expireOverdue(this.clock.now(), { userId });
    const rows = await this.repo.listOwn(userId, query.status, query.limit);
    return rows.map(toTopupIntent);
  }

  /** Own, PENDING and before its deadline; anything else is 404 (docs/04). */
  async cancel(userId: string, intentId: string): Promise<CancelTopupIntentResponse> {
    const now = this.clock.now();
    await this.expireOverdue(now, { userId, id: intentId });
    assertIntentTransition('PENDING', 'CANCELLED', SYSTEM);
    if (!(await this.repo.cancel(userId, intentId, now))) throw new AppError('NOT_FOUND');
    return { intentId, status: 'CANCELLED' };
  }

  /** A new pay link; the old one dies the moment the hash is replaced (docs/04, D-39). */
  async rotatePayLink(userId: string, intentId: string): Promise<PayLinkResponse> {
    const now = this.clock.now();
    await this.expireOverdue(now, { userId, id: intentId });
    const row = await this.repo.findOwn(userId, intentId);
    if (row === null) throw new AppError('NOT_FOUND');
    const owner = await this.repo.findOwner(userId);
    if (owner === null) throw new AppError('NOT_FOUND');
    const token = generatePayToken();
    const hash = hashPayToken(this.config.PAY_TOKEN_PEPPER, row.id, token);
    if (!(await this.repo.rotateToken(userId, row.id, hash, now))) throw new AppError('NOT_FOUND');
    return {
      redirectUrl: this.payLink(row.id, token, owner.locale),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  // The checks after idempotency, in the contract's order, then the card and the INSERT.
  private async createOnce(
    owner: IntentOwner,
    idempotencyKey: string,
    requestHash: string,
    body: CreateTopupIntentBody,
    now: Date,
  ): Promise<TopupIntentCreated> {
    await this.refusePending(owner.id, idempotencyKey, now);
    await this.limits.enforceReservations(owner.id, now);
    const baseTiyin = BigInt(body.amountTiyin);
    await this.limits.enforceAmount(owner, baseTiyin, now);
    if (!(await this.bankFeed.isAlive())) throw new AppError('PAYMENT_METHOD_UNAVAILABLE');

    const token = generatePayToken();
    const created = await this.cards.allocate({
      userId: owner.id,
      baseTiyin,
      ...(body.bank === undefined ? {} : { bank: body.bank }),
      now,
      idempotencyKey,
      requestHash,
      hashFor: (intentId) => hashPayToken(this.config.PAY_TOKEN_PEPPER, intentId, token),
    });
    // After commit, best effort (never throws): the owner hears of a card filling with unpaid holds.
    if (created.cardId !== null) await this.reservedAlert.checkAfterCreate(created.cardId, now);
    return toTopupIntentCreated(created, this.payLink(created.id, token, owner.locale));
  }

  // Same key: the same body gets the same intent back with a NEW token (the plain one was never
  // stored) while it is still PENDING and unexpired; anything else is 409 with the intent id.
  private async replay(
    known: IntentWithCard,
    requestHash: string,
    locale: 'uz' | 'ru',
    now: Date,
  ): Promise<TopupIntentCreated> {
    const conflict = (): AppError => new AppError('IDEMPOTENCY_CONFLICT', { intentId: known.id });
    if (known.requestHash !== requestHash || known.provider !== TOPUP_PROVIDER) throw conflict();
    const token = generatePayToken();
    const hash = hashPayToken(this.config.PAY_TOKEN_PEPPER, known.id, token);
    if (!(await this.repo.rotateToken(known.userId, known.id, hash, now))) throw conflict();
    return toTopupIntentCreated(
      { ...known, payTokenHash: hash },
      this.payLink(known.id, token, locale),
    );
  }

  // One PENDING request per user. An overdue one is expired first (the same PENDING -> EXPIRED
  // the worker's sweep makes), so the user is not told to wait for a request that can no
  // longer be paid on time. A PENDING one created with THIS key is a parallel twin of this
  // request that committed first: the caller answers it as a replay, not as 409.
  private async refusePending(userId: string, idempotencyKey: string, now: Date): Promise<void> {
    await this.expireOverdue(now, { userId });
    const pending = await this.repo.findPending(userId);
    if (pending === null || pending.idempotencyKey === idempotencyKey) return;
    throw new AppError('TOPUP_ALREADY_PENDING', { intentId: pending.id });
  }

  private async expireOverdue(now: Date, scope: { userId: string; id?: string }): Promise<void> {
    assertIntentTransition('PENDING', 'EXPIRED', SYSTEM);
    await this.repo.expireOverdue(now, scope);
  }

  private payLink(intentId: string, token: string, locale: 'uz' | 'ru'): string {
    return buildPayLink(this.config.WEB_URL, intentId, token, locale);
  }
}
