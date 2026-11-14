import { createHash } from 'node:crypto';
import { RecipientProviderRefSchema, type RecipientCheckResult } from '@repo/shared';
import { hasProviderRef, type FulfillmentRecipient } from '../fulfillment-adapter';

// What the simulated providers do, per order (tests) or for every order (dev). Never a secret,
// never a network call: the simulator answers from memory.
//
// Scenario    Fragment simulator (TON-paid)             Reseller simulator (USDT)
// OK          prepare READY at the simulated price      send SENT, confirm DELIVERED
// PRICE_UP    prepare READY at twice the price          the same, twice the price
// NOT_FOUND   validate NOT_FOUND, prepare RECIPIENT_GONE the same
// NOT_SENT    prepare REFUSED (Fragment refuses)        send NOT_SENT (MANUAL proof: review)
// UNKNOWN     prepare throws (Fragment unreachable)     send UNKNOWN
// TIMEOUT     prepare throws (Fragment times out)       send SENT, confirm PENDING for ever
//
// The TON side of a Fragment payout (landed, lost, bounced...) is scripted on the fake chain
// (FakeTonGateway), not here.

export const SIM_SCENARIOS = [
  'OK',
  'PRICE_UP',
  'NOT_FOUND',
  'NOT_SENT',
  'UNKNOWN',
  'TIMEOUT',
] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

export class SimulatorScript {
  private fallback: SimScenario = 'OK';
  private readonly byOrder = new Map<string, SimScenario>();

  /** Every order without a scenario of its own. */
  setDefault(scenario: SimScenario): void {
    this.fallback = scenario;
  }

  set(orderId: string, scenario: SimScenario): void {
    this.byOrder.set(orderId, scenario);
  }

  scenarioFor(orderId: string | null): SimScenario {
    return (orderId === null ? undefined : this.byOrder.get(orderId)) ?? this.fallback;
  }
}

/** The handle the simulators give a username (and expect back on the order). */
export function simulatedProviderRef(username: string): string {
  return RecipientProviderRefSchema.parse(`sim_${username}`);
}

/**
 * The simulated Fragment payee: a fixed workchain-0 address no key is known for (sha256 of a
 * label), so value sent to it on a real chain would be lost. Only the in-memory chain ever sees
 * it. Dev: add it to FRAGMENT_PAY_ADDRESSES to let dry-run payouts through (docs/06 "Dev va test").
 */
export const SIMULATED_FRAGMENT_PAY_ADDRESS = `0:${createHash('sha256')
  .update('simulated fragment pay address')
  .digest('hex')}`;

/** Thrown by a simulated provider that is "unreachable" (scenarios UNKNOWN and TIMEOUT). */
export class SimulatedOutageError extends Error {
  constructor(scenario: SimScenario) {
    super(`simulated provider outage (${scenario})`);
    this.name = 'SimulatedOutageError';
  }
}

/** `validateRecipient` of both simulators. */
export function simulatedValidation(
  scenario: SimScenario,
  input: Readonly<Record<string, string>>,
): RecipientCheckResult {
  const username = input['username'];
  if (scenario === 'NOT_FOUND' || username === undefined || username === '') {
    return { status: 'NOT_FOUND' };
  }
  if (scenario === 'UNKNOWN' || scenario === 'TIMEOUT') return { status: 'UNAVAILABLE' };
  return { status: 'FOUND', providerRef: simulatedProviderRef(username), displayName: username };
}

/** The recipient re-check of `prepare`: null when it is still the validated one. */
export function simulatedRecipientProblem(
  scenario: SimScenario,
  recipient: FulfillmentRecipient,
): 'RECIPIENT_GONE' | 'RECIPIENT_CHANGED' | null {
  if (!hasProviderRef(recipient) || scenario === 'NOT_FOUND') return 'RECIPIENT_GONE';
  const username = recipient.fields['username'];
  if (username === undefined || username === '') return 'RECIPIENT_GONE';
  return recipient.providerRef === simulatedProviderRef(username) ? null : 'RECIPIENT_CHANGED';
}
