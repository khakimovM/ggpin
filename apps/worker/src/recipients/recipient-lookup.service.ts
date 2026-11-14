import { Injectable } from '@nestjs/common';
import {
  ProductInputSchema,
  RecipientCheckResultSchema,
  normalizeRecipientInput,
  type RecipientCheckRequest,
  type RecipientCheckResult,
  type RecipientInputIssue,
} from '@repo/shared';
import { AdapterRouter } from '../fulfillment/adapter-router';
import { Deadline, TIMED_OUT } from './deadline';
import { RecipientProductRepository } from './recipient-product.repository';

/** Why a check ended as it did: logged (with the adapter code), never a value. */
export type LookupReason =
  | 'ANSWERED'
  | 'NO_PRODUCT'
  | 'INACTIVE'
  | 'BAD_PRODUCT_INPUT'
  | 'NO_ADAPTER'
  | 'TIMEOUT'
  | 'BAD_ANSWER'
  | 'ERROR';

export type LookupOutcome =
  | {
      readonly kind: 'RESULT';
      readonly result: RecipientCheckResult;
      readonly reason: LookupReason;
      readonly adapter: string | null;
      /** The error's class name for `ERROR` (never its message: it may quote the input). */
      readonly errorName?: string;
    }
  /** The input does not fit the product's form: the producer's bug, not an outage. */
  | { readonly kind: 'INVALID_INPUT'; readonly issues: readonly RecipientInputIssue['code'][] };

const UNAVAILABLE: RecipientCheckResult = { status: 'UNAVAILABLE' };

/** A class name is safe to log; anything else in it is cut away. */
export function errorNameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : 'non-Error';
  return name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'Error';
}

/**
 * Who is this recipient (docs/04 `POST /recipients/validate`, docs/06 S3b)? Product -> adapter by
 * the router (enabled ProductRoute rows by priority, health OK) -> `validateRecipient` with the
 * input normalized again against the product's own form. Fail-closed: whatever keeps us from a
 * provider's clear answer (no product, inactive, no healthy adapter, out of time, a throw, an
 * answer that does not parse) is UNAVAILABLE, never NOT_FOUND. Never throws.
 */
@Injectable()
export class RecipientLookupService {
  constructor(
    private readonly products: RecipientProductRepository,
    private readonly router: AdapterRouter,
  ) {}

  /**
   * `budgetMs`: the whole lookup's time. `minCallMs`: the provider is asked only with at least this
   * much left (a slow database or router must not lead to a call that cannot answer in time).
   */
  async check(
    request: RecipientCheckRequest,
    budgetMs: number,
    minCallMs: number,
  ): Promise<LookupOutcome> {
    const deadline = new Deadline(budgetMs);
    let adapter: string | null = null;
    const unavailable = (reason: LookupReason, errorName?: string): LookupOutcome => ({
      kind: 'RESULT',
      result: UNAVAILABLE,
      reason,
      adapter,
      ...(errorName === undefined ? {} : { errorName }),
    });
    try {
      const product = await deadline.race(this.products.find(request.productId));
      if (product === TIMED_OUT) return unavailable('TIMEOUT');
      if (product === null) return unavailable('NO_PRODUCT');
      if (!product.isActive) return unavailable('INACTIVE');
      const fields = ProductInputSchema.safeParse(product.inputSchema);
      if (!fields.success) return unavailable('BAD_PRODUCT_INPUT');
      const input = normalizeRecipientInput(fields.data, request.input);
      if (!input.ok) return { kind: 'INVALID_INPUT', issues: input.issues.map((i) => i.code) };

      const picked = await deadline.race(this.router.pick(product.id, null));
      if (picked === TIMED_OUT) return unavailable('TIMEOUT');
      if (picked === null) return unavailable('NO_ADAPTER');
      adapter = picked.code;
      if (deadline.remainingMs() < minCallMs) return unavailable('TIMEOUT');

      const ref = { id: product.id, slug: product.slug };
      const answer = await deadline.race(picked.validateRecipient(ref, input.input));
      if (answer === TIMED_OUT) return unavailable('TIMEOUT');
      // The adapter's answer is third-party data (a display name of any length or content).
      const parsed = RecipientCheckResultSchema.safeParse(answer);
      if (!parsed.success) return unavailable('BAD_ANSWER');
      return { kind: 'RESULT', result: parsed.data, reason: 'ANSWERED', adapter };
    } catch (error) {
      return unavailable('ERROR', errorNameOf(error));
    } finally {
      deadline.dispose();
    }
  }
}
