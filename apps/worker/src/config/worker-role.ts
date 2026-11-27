import { WORKER_ROLES, type WorkerRole } from '@repo/shared';

type Source = Readonly<Record<string, string | undefined>>;

export interface WorkerRoleCheck {
  /** Undefined when the value is missing (production) or not a role: nothing is owned then. */
  readonly role: WorkerRole | undefined;
  readonly problems: readonly string[];
}

const ROLE_LIST = WORKER_ROLES.join(', ');

function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

const NODE_ENVS = ['development', 'test', 'production'] as const;

function isKnownNodeEnv(value: string | undefined): boolean {
  return (NODE_ENVS as readonly (string | undefined)[]).includes(value);
}

/**
 * WORKER_ROLE (D-76): `fulfillment` (TON, Fragment, fulfill-order, recipients, price/FX sync, the
 * order reconciler) or `bankfeed` (the bank-feed listener and history re-scan, ingest, the P2P
 * matcher, card limits, top-up expiry, the payment reconciliation). `all` runs both in one process
 * and is for development and tests only. There is no default and `all` is refused unless NODE_ENV
 * is exactly development or test (SA F-3): a missing or misspelt NODE_ENV gets the production
 * rule, so a forgotten role never puts the wallet key and the bank-feed session into one process.
 * Exact spelling (case too); the message never echoes the value. `source` has no blank values.
 */
export function parseWorkerRole(source: Source): WorkerRoleCheck {
  const relaxed = source.NODE_ENV === 'development' || source.NODE_ENV === 'test';
  const value = source.WORKER_ROLE;
  if (value === undefined) {
    return relaxed
      ? { role: 'all', problems: [] }
      : {
          role: undefined,
          problems: [
            'WORKER_ROLE: is required in production and whenever NODE_ENV is not development or test (fulfillment or bankfeed)',
          ],
        };
  }
  if (!isWorkerRole(value)) {
    return { role: undefined, problems: [`WORKER_ROLE: must be one of ${ROLE_LIST}`] };
  }
  if (!relaxed && value === 'all') {
    return {
      role: undefined,
      problems: [
        'WORKER_ROLE: all is refused in production and whenever NODE_ENV is not development or test (run fulfillment and bankfeed as two containers)',
      ],
    };
  }
  return { role: value, problems: [] };
}

export type WorkerSide = 'fulfillment' | 'bankfeed';

/**
 * The two switches of the other side, read here only to refuse a contradiction (D-52 (8): one
 * bank-feed connection, and it lives in the bankfeed container; the bankfeed container never sends
 * value, so a stray FULFILLMENT_DRY_RUN=false must not pass silently).
 */
export function roleFlagProblems(role: WorkerRole | undefined, source: Source): string[] {
  const problems: string[] = [];
  const mode = source.BANK_FEED_MODE;
  if (role === 'fulfillment' && mode !== undefined && mode !== 'off') {
    problems.push(
      'BANK_FEED_MODE: must be off (or unset) with WORKER_ROLE=fulfillment; the bank feed runs in the bankfeed container',
    );
  }
  const dryRun = source.FULFILLMENT_DRY_RUN;
  if (role === 'bankfeed' && dryRun !== undefined && dryRun !== 'true') {
    problems.push(
      'FULFILLMENT_DRY_RUN: must be true (or unset) with WORKER_ROLE=bankfeed; the bankfeed container never sends value',
    );
  }
  return problems;
}

/**
 * Whether this role runs that side (and so may read its secrets). No role owns nothing, and with a
 * NODE_ENV that is not one of the three nothing is read at all (SA F-3): that boot fails anyway.
 */
export function roleRuns(role: WorkerRole | undefined, side: WorkerSide, source: Source): boolean {
  return isKnownNodeEnv(source.NODE_ENV) && (role === 'all' || role === side);
}
