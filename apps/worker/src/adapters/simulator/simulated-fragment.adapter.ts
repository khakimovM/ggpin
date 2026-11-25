import {
  fragmentProductKind,
  isPremiumMonths,
  type AdapterHealth,
  type CostCurrency,
  type FragmentProductKind,
  type RecipientCheckResult,
} from '@repo/shared';
import { beginCell } from '@ton/core';
import { FRAGMENT_ADAPTER } from '../../pricing-sync/cost-sources/cost-source';
import type {
  AdapterBalance,
  ConfirmResult,
  FulfillmentAdapter,
  PrepareContext,
  PrepareResult,
  ProductRef,
  SendResult,
  SkuRef,
} from '../fulfillment-adapter';
import { SIMULATED_PREMIUM_NANO_TON, SIMULATED_STAR_NANO_TON } from './simulated-fragment-prices';
import { assertSimulatorAllowed, type SimulatorEnv } from './simulator-guard';
import {
  SIMULATED_FRAGMENT_PAY_ADDRESS,
  SimulatedOutageError,
  simulatedRecipientProblem,
  simulatedValidation,
  type SimulatorScript,
} from './simulator-script';

// The FRAGMENT adapter of a dry run (plan §8): never reaches fragment.com. `prepare` answers like
// Fragment's "init" would, with a TON instruction (payee, amount, payload) that the fulfillment
// core hands to the TON module; the payout itself happens on the in-memory chain. `send` and
// `confirm` are not used for a TON-paid adapter (the TON module sends and confirms), so they
// answer UNKNOWN: a misuse ends in NEEDS_REVIEW, never in a delivery.

/**
 * The simulated Fragment price of an order line, nanotons (simulated-fragment-prices.ts). The
 * product kind comes from the slug (fragmentProductKind, owner Q4), never from the SKU size: a
 * Telegram Premium line is a 3, 6 or 12 month pack (null for any other line: nothing is priced,
 * nothing is paid); everything else is Stars, per unit, whatever its pack size. Dry run only: an
 * unknown slug is priced as Stars here so test catalogs may use their own slugs; the real adapter
 * (p5 S8 / P6-S3) refuses a product it cannot name.
 */
export function simulatedFragmentCost(
  kind: FragmentProductKind | null,
  sku: SkuRef,
): bigint | null {
  if (kind !== 'PREMIUM') return SIMULATED_STAR_NANO_TON * BigInt(sku.quantity);
  if (sku.id === null || !isPremiumMonths(sku.quantity)) return null;
  return SIMULATED_PREMIUM_NANO_TON.get(sku.quantity) ?? null;
}

export class SimulatedFragmentAdapter implements FulfillmentAdapter {
  readonly code = FRAGMENT_ADAPTER;
  readonly costCurrency = 'TON';

  /**
   * `sessionHealth`: the Fragment session's health (S7: DOWN once the keep-alive declared it
   * DEAD); without it the simulated Fragment is always up.
   */
  constructor(
    env: SimulatorEnv,
    private readonly script: SimulatorScript,
    private readonly sessionHealth: () => Promise<AdapterHealth> = () => Promise.resolve('OK'),
  ) {
    assertSimulatorAllowed(env);
  }

  validateRecipient(
    product: ProductRef,
    input: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<RecipientCheckResult> {
    const kind = fragmentProductKind(product.slug);
    return simulatedValidation(this.script.scenarioFor(null), input, signal, kind);
  }

  quote(
    product: ProductRef,
    sku: SkuRef,
  ): Promise<{ readonly currency: CostCurrency; readonly costMinor: bigint }> {
    const costMinor = simulatedFragmentCost(fragmentProductKind(product.slug), sku);
    if (costMinor === null) return Promise.reject(new Error('no simulated price for this line'));
    return Promise.resolve({ currency: 'TON', costMinor });
  }

  prepare(context: PrepareContext): Promise<PrepareResult> {
    const scenario = this.script.scenarioFor(context.orderId);
    if (scenario === 'UNKNOWN' || scenario === 'TIMEOUT') {
      return Promise.reject(new SimulatedOutageError(scenario));
    }
    const kind = fragmentProductKind(context.product.slug);
    const problem = simulatedRecipientProblem(scenario, context.recipient, kind);
    if (problem !== null) return Promise.resolve({ status: problem });
    if (scenario === 'GOT_PREMIUM') return Promise.resolve({ status: 'RECIPIENT_REFUSED' });
    if (scenario === 'NOT_SENT') {
      return Promise.resolve({ status: 'REFUSED', reason: 'simulated refusal' });
    }
    const base = simulatedFragmentCost(kind, context.sku);
    if (base === null) {
      return Promise.resolve({ status: 'REFUSED', reason: 'simulated: not a Premium term' });
    }
    const costMinor = scenario === 'PRICE_UP' ? base * 2n : base;
    const payload = beginCell()
      .storeUint(0, 32)
      .storeStringTail(`simulated order ${context.orderId} #${String(context.attemptNo)}`)
      .endCell();
    return Promise.resolve({
      status: 'READY',
      prepared: {
        adapter: this.code,
        costCurrency: 'TON',
        costMinor,
        request: {
          simulated: true,
          ton: {
            toAddress: SIMULATED_FRAGMENT_PAY_ADDRESS,
            amountNano: costMinor.toString(),
            payloadBoc: payload.toBoc().toString('base64'),
          },
        },
        externalRef: null,
      },
    });
  }

  send(): Promise<SendResult> {
    return Promise.resolve({ status: 'UNKNOWN', detail: 'a TON-paid adapter is not sent here' });
  }

  confirm(): Promise<ConfirmResult> {
    return Promise.resolve({
      status: 'UNKNOWN',
      detail: 'a TON-paid adapter is confirmed on chain',
    });
  }

  getBalance(): Promise<AdapterBalance> {
    return Promise.resolve({ currency: 'TON', amountMinor: 0n });
  }

  health(): Promise<AdapterHealth> {
    return this.sessionHealth();
  }
}
