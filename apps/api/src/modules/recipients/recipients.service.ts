import { Injectable } from '@nestjs/common';
import {
  ProductInputSchema,
  normalizeRecipientInput,
  type ProductInput,
  type RecipientCheckResult,
  type ValidateRecipientBody,
  type ValidateRecipientResponse,
} from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import { RecipientCheckClient } from './recipient-check.client';
import { RecipientCheckGate } from './recipient-check.gate';
import { RecipientTokenStore } from './recipient-token.store';
import { RecipientsRepository, type RecipientProduct } from './recipients.repository';

/** Checks per user per window (docs/04 Q-E: 20 a minute). Each one may cost a provider lookup. */
export const RECIPIENT_CHECK_LIMIT = { max: 20, windowSec: 60 } as const;

export const recipientCheckLimitKey = (userId: string): string => `rl:rcpt:${userId}`;

/**
 * `POST /recipients/validate` (docs/04): turns "this product, this input" into the name the user
 * confirms and a recipient token bound to (user, product) for 10 minutes. Domain invariant 8:
 * the token is the only link between the name the user saw and the quote and order that follow,
 * so it is issued ONLY for a recipient the provider found, carrying the provider's handle that
 * fulfillment re-checks before paying (Q21).
 *
 * Order: limit, product, input, one-at-a-time slot, provider lookup, token. Nothing is written
 * before the lookup answers FOUND (an allow-list: any other answer, including one added to the
 * job contract later, issues no token). The username and the name never reach a log line (the client logs fixed text).
 *
 * Redis outage: the limiter, the slot and the token store throw (500, fail closed); the lookup itself
 * answers 503 RECIPIENT_CHECK_UNAVAILABLE.
 */
@Injectable()
export class RecipientsService {
  constructor(
    private readonly repository: RecipientsRepository,
    private readonly checks: RecipientCheckClient,
    private readonly tokens: RecipientTokenStore,
    private readonly counter: FixedWindowCounter,
    private readonly gate: RecipientCheckGate,
  ) {}

  async validate(userId: string, body: ValidateRecipientBody): Promise<ValidateRecipientResponse> {
    await this.enforceLimit(userId);

    const product = await this.repository.findProduct(body.productId);
    if (product === null) throw new AppError('NOT_FOUND');
    if (!product.isActive) throw new AppError('PRODUCT_UNAVAILABLE');

    const fields = parseInputSchema(product);
    const usernameField = fields.length === 1 ? fields[0] : undefined;
    // A recipient token carries a Telegram username (RecipientSchema); a product whose form is
    // anything else (no field, game fields) cannot be validated in this phase.
    if (usernameField?.type !== 'tgUsername') throw new AppError('PRODUCT_UNAVAILABLE');

    const normalized = normalizeRecipientInput(fields, body.input);
    if (!normalized.ok) throw new AppError('VALIDATION_ERROR', { fields: normalized.issues });
    const username = normalized.input[usernameField.key];
    if (username === undefined) throw new AppError('VALIDATION_ERROR');

    // One running check per user: a second one at the same time is 429 (audit M-1 (a)).
    const slot = await this.gate.acquire(userId);
    if (!('release' in slot)) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: slot.retryAfterSec });
    }
    try {
      const result = await this.checks.check({ productId: product.id, input: normalized.input });
      const found = foundOrThrow(result);
      const recipientToken = await this.tokens.issue(
        userId,
        product.id,
        { username, displayName: found.displayName },
        found.providerRef,
      );
      // No photoUrl in phase 5 (plan Q12): third-party image hosts and CSP. No warning exists yet.
      return { recipientToken, displayName: found.displayName, warnings: [] };
    } finally {
      await slot.release();
    }
  }

  private async enforceLimit(userId: string): Promise<void> {
    const hit = await this.counter.hit(
      recipientCheckLimitKey(userId),
      RECIPIENT_CHECK_LIMIT.windowSec,
    );
    if (hit.count > RECIPIENT_CHECK_LIMIT.max) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
  }
}

// A stored form that does not parse is a catalog bug, not the user's fault: 500 and a log line
// (the filter logs INTERNAL_ERROR), never a 400 that would blame the input.
function parseInputSchema(product: RecipientProduct): ProductInput {
  const parsed = ProductInputSchema.safeParse(product.inputSchema);
  if (!parsed.success) throw new Error('product input schema does not parse');
  return parsed.data;
}

type FoundRecipient = Extract<RecipientCheckResult, { readonly status: 'FOUND' }>;

// Allow-list (audit L-3): only FOUND goes on to a token. A status added to the job contract later
// (e.g. HAS_PREMIUM) breaks this switch at compile time instead of slipping through.
function foundOrThrow(result: RecipientCheckResult): FoundRecipient {
  switch (result.status) {
    case 'FOUND':
      return result;
    case 'NOT_FOUND':
      throw new AppError('RECIPIENT_NOT_FOUND');
    case 'UNAVAILABLE':
      throw new AppError('RECIPIENT_CHECK_UNAVAILABLE');
    default:
      return unexpectedStatus(result);
  }
}

// The value may hold a name or a provider handle: it is never put into the error or a log line.
function unexpectedStatus(result: never): never {
  void result;
  throw new Error('unexpected recipient check status');
}
