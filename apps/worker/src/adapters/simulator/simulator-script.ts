import { createHash } from 'node:crypto';
import {
  RECIPIENT_CHECK_TIMEOUT_MS,
  RecipientProviderRefSchema,
  normalizeTgUsername,
  type RecipientCheckResult,
} from '@repo/shared';
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
//
// `validateRecipient` under OK also answers by the username's shape (dev and tests, docs/06 S3b),
// always on the normalized username (normalizeTgUsername: no `@`, lower case):
//   notfound_*   NOT_FOUND (and `prepare` of such a recipient: RECIPIENT_GONE)
//   slowcheck_*  answers only after SIM_SLOW_CHECK_MS, longer than any caller waits: UNAVAILABLE
//   any other    FOUND, providerRef `sim_<username>`, displayName = the username

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

/** Username prefixes the simulated `validateRecipient` answers by (scenario OK only). */
export const SIM_NOT_FOUND_PREFIX = 'notfound_';
export const SIM_SLOW_CHECK_PREFIX = 'slowcheck_';
/** How long a `slowcheck_*` lookup takes: longer than the API ever waits for an answer. */
export const SIM_SLOW_CHECK_MS = RECIPIENT_CHECK_TIMEOUT_MS + 5_000;

const NOT_FOUND: RecipientCheckResult = { status: 'NOT_FOUND' };
const UNAVAILABLE: RecipientCheckResult = { status: 'UNAVAILABLE' };

/** The raw `username` field (own key only); undefined when absent or blank. */
function rawUsernameOf(fields: Readonly<Record<string, string>>): string | undefined {
  const raw = Object.hasOwn(fields, 'username') ? fields['username'] : undefined;
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** The normalized username of an input or a stored recipient; null when there is none. */
function usernameOf(fields: Readonly<Record<string, string>>): string | null {
  const raw = rawUsernameOf(fields);
  return raw === undefined ? null : normalizeTgUsername(raw);
}

// The timer is unref'd: a caller that stopped waiting (the validate-recipient deadline) never
// keeps a test or a stopping worker alive for it.
function slowAnswer(): Promise<RecipientCheckResult> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(UNAVAILABLE), SIM_SLOW_CHECK_MS).unref();
  });
}

/**
 * `validateRecipient` of both simulators.
 * - No `username` field, or a blank one: UNAVAILABLE. The question itself is malformed (a form
 *   mismatch, our bug), so no answer about a person is given: fail-closed (CR #11).
 * - A value that cannot be a Telegram username (`x`, `1abc`): NOT_FOUND, which is what the real
 *   provider answers when searching for it — there is a question, and nobody has that name.
 */
export function simulatedValidation(
  scenario: SimScenario,
  input: Readonly<Record<string, string>>,
): Promise<RecipientCheckResult> {
  if (rawUsernameOf(input) === undefined) return Promise.resolve(UNAVAILABLE);
  const username = usernameOf(input);
  if (scenario === 'NOT_FOUND' || username === null) return Promise.resolve(NOT_FOUND);
  if (scenario === 'UNKNOWN' || scenario === 'TIMEOUT') return Promise.resolve(UNAVAILABLE);
  if (scenario === 'OK' && username.startsWith(SIM_NOT_FOUND_PREFIX)) {
    return Promise.resolve(NOT_FOUND);
  }
  if (scenario === 'OK' && username.startsWith(SIM_SLOW_CHECK_PREFIX)) return slowAnswer();
  return Promise.resolve({
    status: 'FOUND',
    providerRef: simulatedProviderRef(username),
    displayName: username,
  });
}

/**
 * The recipient re-check of `prepare`: null when it is still the validated one. Consistent with
 * `simulatedValidation`: for every normalized username it answers FOUND for, its providerRef
 * gives null here, so a dry-run order is never refunded as RECIPIENT_CHANGED.
 */
export function simulatedRecipientProblem(
  scenario: SimScenario,
  recipient: FulfillmentRecipient,
): 'RECIPIENT_GONE' | 'RECIPIENT_CHANGED' | null {
  if (!hasProviderRef(recipient) || scenario === 'NOT_FOUND') return 'RECIPIENT_GONE';
  const username = usernameOf(recipient.fields);
  if (username === null) return 'RECIPIENT_GONE';
  if (scenario === 'OK' && username.startsWith(SIM_NOT_FOUND_PREFIX)) return 'RECIPIENT_GONE';
  return recipient.providerRef === simulatedProviderRef(username) ? null : 'RECIPIENT_CHANGED';
}
