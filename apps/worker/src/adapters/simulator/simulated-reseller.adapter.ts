import type { CostCurrency, NeedsReviewProof, RecipientCheckResult } from '@repo/shared';
import type {
  AdapterBalance,
  ConfirmResult,
  FulfillmentAdapter,
  PrepareContext,
  PrepareResult,
  PreparedFulfillment,
  ProductRef,
  SendResult,
  SkuRef,
} from '../fulfillment-adapter';
import { assertSimulatorAllowed, type SimulatorEnv } from './simulator-guard';
import {
  simulatedRecipientProblem,
  simulatedValidation,
  type SimulatorScript,
} from './simulator-script';

// The RESELLER_STARS backup provider of a dry run (docs/06 "Zaxira provayder", plan §8): a
// supplier paid in USDT from its own balance, through send -> confirm. Fake prices, no network.

export const RESELLER_STARS_ADAPTER = 'RESELLER_STARS';

/** FAKE: 0.015 USDT per Star, in micro-USDT. Not any reseller's real price. */
export const SIMULATED_STAR_MICRO_USDT = 15_000n;

/**
 * The supplier's order reference, known before sending (rules/45 step 5): the order id is the
 * idempotency key (CLAUDE.md §5.4), never the attempt number, so a repeat can never be a new order
 * at the supplier.
 */
export function simulatedSupplierRef(orderId: string): string {
  return `sim-${orderId}`;
}

// The "not sent" answer a supplier gives when it refuses before taking the order. No supplier
// proof kind exists yet (S8): this MANUAL proof is what an adapter could claim, and the core
// refuses to act on it (operator-only, CR M2), so the order goes to NEEDS_REVIEW.
const REFUSAL_PROOF: NeedsReviewProof = {
  kind: 'MANUAL',
  evidence: 'simulated supplier refused the order before accepting it',
  reason: 'simulated refusal',
};

export class SimulatedResellerAdapter implements FulfillmentAdapter {
  readonly code = RESELLER_STARS_ADAPTER;

  constructor(
    env: SimulatorEnv,
    private readonly script: SimulatorScript,
  ) {
    assertSimulatorAllowed(env);
  }

  validateRecipient(
    _product: ProductRef,
    input: Readonly<Record<string, string>>,
  ): Promise<RecipientCheckResult> {
    return Promise.resolve(simulatedValidation(this.script.scenarioFor(null), input));
  }

  quote(
    _product: ProductRef,
    sku: SkuRef,
  ): Promise<{ readonly currency: CostCurrency; readonly costMinor: bigint }> {
    return Promise.resolve({
      currency: 'USDT',
      costMinor: SIMULATED_STAR_MICRO_USDT * BigInt(sku.quantity),
    });
  }

  prepare(context: PrepareContext): Promise<PrepareResult> {
    const scenario = this.script.scenarioFor(context.orderId);
    const problem = simulatedRecipientProblem(scenario, context.recipient);
    if (problem !== null) return Promise.resolve({ status: problem });
    const base = SIMULATED_STAR_MICRO_USDT * BigInt(context.sku.quantity);
    const costMinor = scenario === 'PRICE_UP' ? base * 2n : base;
    const externalRef = simulatedSupplierRef(context.orderId);
    return Promise.resolve({
      status: 'READY',
      prepared: {
        adapter: this.code,
        costCurrency: 'USDT',
        costMinor,
        request: {
          simulated: true,
          supplierRef: externalRef,
          amountMicroUsdt: costMinor.toString(),
        },
        externalRef,
      },
    });
  }

  send(context: PrepareContext, prepared: PreparedFulfillment): Promise<SendResult> {
    const scenario = this.script.scenarioFor(context.orderId);
    if (scenario === 'NOT_SENT')
      return Promise.resolve({ status: 'NOT_SENT', proof: REFUSAL_PROOF });
    if (scenario === 'UNKNOWN') return Promise.resolve({ status: 'UNKNOWN', detail: 'simulated' });
    if (prepared.externalRef === null) return Promise.resolve({ status: 'UNKNOWN' });
    return Promise.resolve({
      status: 'SENT',
      externalRef: prepared.externalRef,
      response: { simulated: true },
    });
  }

  confirm(context: PrepareContext): Promise<ConfirmResult> {
    const scenario = this.script.scenarioFor(context.orderId);
    if (scenario === 'TIMEOUT') return Promise.resolve({ status: 'PENDING' });
    if (scenario === 'OK' || scenario === 'PRICE_UP') {
      return Promise.resolve({ status: 'DELIVERED', response: { simulated: true } });
    }
    return Promise.resolve({ status: 'UNKNOWN', detail: 'simulated' });
  }

  getBalance(): Promise<AdapterBalance> {
    return Promise.resolve({ currency: 'USDT', amountMinor: 1_000_000_000n });
  }

  health(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}
