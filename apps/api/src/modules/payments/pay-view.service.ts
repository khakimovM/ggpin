import { Inject, Injectable } from '@nestjs/common';
import type { PayView } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import { toPayView } from './entities/pay-view.mapper';
import { payTokenCandidate, payTokenMatches } from './pay-token';
import { TopupIntentsRepository, type PayGate } from './topup-intents.repository';

/** Reads per intent per minute, counted only after the token proved itself (D-39). */
export const PAY_VIEW_INTENT_LIMIT = { max: 30, windowSec: 60 } as const;
export const payViewLimitKey = (intentId: string): string => `rl:pay:${intentId}`;

const notFound = (): AppError => new AppError('NOT_FOUND');

/**
 * `GET /payments/pay/:intentId` with `X-Pay-Token` (docs/04, D-39). Every refusal is the SAME
 * `404 NOT_FOUND`. Two steps, so a request without the right token costs the same work whatever
 * was wrong (malformed id or token, unknown intent, no hash because cancelled, rotated token,
 * expired): one HMAC, ONE narrow lookup by primary key, one constant-time comparison. Only a
 * matching token loads the card and the owner (step 2). Valid until `expiresAt`, read-only.
 */
@Injectable()
export class PayViewService {
  constructor(
    private readonly repo: TopupIntentsRepository,
    private readonly counter: FixedWindowCounter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async read(intentId: string, token: string | undefined): Promise<PayView> {
    const now = this.clock.now();
    const candidate = payTokenCandidate(this.config.PAY_TOKEN_PEPPER, intentId, token);
    const gate = await this.repo.findPayGate(candidate.lookupId);
    const matches = payTokenMatches(candidate.hash, gate?.payTokenHash ?? null);
    if (gate === null || !candidate.wellFormed || !matches || !isOpen(gate, now)) {
      throw notFound();
    }
    const details = await this.repo.findPayDetails(gate.id);
    // Step 2 re-checks the token on the row it is about to show: a rotation (or a cancel)
    // committed between the two reads must not serve the card to the old link (n2). A blocked
    // owner's link is dead like any other (S4-04): the same 404, nothing about why.
    if (
      details === null ||
      !payTokenMatches(candidate.hash, details.payTokenHash) ||
      details.user.isBlocked ||
      !isOpen(details, now)
    ) {
      throw notFound();
    }
    const hit = await this.counter.hit(payViewLimitKey(gate.id), PAY_VIEW_INTENT_LIMIT.windowSec);
    if (hit.count > PAY_VIEW_INTENT_LIMIT.max) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
    return toPayView(details, details.user);
  }
}

/** P2P, not cancelled, before its deadline (`now < expiresAt`, the bound every route uses). */
function isOpen(row: Pick<PayGate, 'provider' | 'status' | 'expiresAt'>, now: Date): boolean {
  return (
    row.provider === 'P2P_CARD' &&
    row.status !== 'CANCELLED' &&
    now.getTime() < row.expiresAt.getTime()
  );
}
