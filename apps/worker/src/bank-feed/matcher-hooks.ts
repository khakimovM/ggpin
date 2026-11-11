import type { Tx } from '@repo/db';

/**
 * Test seams of the matcher transaction, a provider so an e2e can pause inside the card lock
 * (pg_locks test, parallel processors) or fail half-way (rollback test). Production uses
 * `NO_MATCHER_HOOKS`; nothing in them may write.
 */
export const MATCHER_HOOKS = Symbol('MATCHER_HOOKS');

export interface MatcherHooks {
  /** Right after `lockTopupCard`, before anything is read under it. */
  afterCardLock(tx: Tx, cardId: string): Promise<void>;
  /** CREDIT: after the first candidate verdict, before the intent row is locked (a race window). */
  beforeIntentLock(tx: Tx, intentId: string): Promise<void>;
  /** After every write of a decision, before the transaction commits. */
  beforeCommit(tx: Tx, bankMessageId: string): Promise<void>;
  /** A parallel processor's outcome won: ours hit a unique key and rolled back whole. */
  settledByOther(bankMessageId: string): Promise<void>;
}

export const NO_MATCHER_HOOKS: MatcherHooks = Object.freeze({
  afterCardLock: () => Promise.resolve(),
  beforeIntentLock: () => Promise.resolve(),
  beforeCommit: () => Promise.resolve(),
  settledByOther: () => Promise.resolve(),
});
