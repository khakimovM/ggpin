import type { Db } from '../../infra/prisma/db';
import { assertWithinDeadline } from './admin-deadline';
import { isAdminActor, type CheckedAuditActor } from './audit-actor';

/**
 * The repository that opens the transaction, with its own timeouts (Prisma stays in the
 * repositories). A repository whose `transaction` takes more arguments passes an adapter, e.g.
 * `{ transaction: (fn) => repo.transaction(fn, timeoutMs) }`.
 */
export interface ActorTransactionRepository {
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

// The transactions runActorTransaction opened (CR-1, SA L-1): confirmActorInTx refuses an admin
// actor in any other, so a service that opens a bare `$transaction` cannot skip point 3 unnoticed.
const actorTransactions = new WeakSet<object>();

/** Whether `tx` was opened by runActorTransaction (and so is checked before its commit). */
export function isActorTransaction(tx: Db): boolean {
  return actorTransactions.has(tx);
}

/**
 * Every transaction that acts for an AuditActor (the one that calls confirmActorInTx) runs through
 * here: after its work and before the commit, an admin's request deadline is checked once more
 * (docs/04 «So‘rov deadline’i», point 3). Past it, the throw rolls everything back (ledger, state
 * and the audit row with the key's id), so the answer is 503 ADMIN_DEADLINE_EXCEEDED with nothing
 * written and the key still free. The owner CLI has no deadline. confirmActorInTx refuses an
 * admin actor in a transaction this helper did not open (a static test checks the pairing too).
 */
export function runActorTransaction<T>(
  repo: ActorTransactionRepository,
  actor: CheckedAuditActor,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return repo.transaction(async (tx) => {
    actorTransactions.add(tx);
    const result = await fn(tx);
    if (isAdminActor(actor)) assertWithinDeadline(actor.deadline);
    return result;
  });
}
