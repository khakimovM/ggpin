import type { CostCurrency, RecipientCheckResult } from '@repo/shared';
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

/** The simulated Fragment price of an order line, nanotons (simulated-fragment-prices.ts). */
export function simulatedFragmentCost(sku: SkuRef): bigint {
  const pack = sku.id === null ? undefined : SIMULATED_PREMIUM_NANO_TON.get(sku.quantity);
  return pack ?? SIMULATED_STAR_NANO_TON * BigInt(sku.quantity);
}

export class SimulatedFragmentAdapter implements FulfillmentAdapter {
  readonly code = FRAGMENT_ADAPTER;

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
    return Promise.resolve({ currency: 'TON', costMinor: simulatedFragmentCost(sku) });
  }

  prepare(context: PrepareContext): Promise<PrepareResult> {
    const scenario = this.script.scenarioFor(context.orderId);
    if (scenario === 'UNKNOWN' || scenario === 'TIMEOUT') {
      return Promise.reject(new SimulatedOutageError(scenario));
    }
    const problem = simulatedRecipientProblem(scenario, context.recipient);
    if (problem !== null) return Promise.resolve({ status: problem });
    if (scenario === 'NOT_SENT') {
      return Promise.resolve({ status: 'REFUSED', reason: 'simulated refusal' });
    }
    const base = simulatedFragmentCost(context.sku);
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

  health(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}
