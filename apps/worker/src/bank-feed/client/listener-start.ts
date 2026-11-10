import { alertRef } from '@repo/shared';
import type { BankFeedAccountRepository } from './bank-feed-account.repository';
import { BankFeedFatalError, type BankFeedListenerClient } from './bank-feed-client';
import type { ListenerAlerts } from './listener-alerts';

export interface StartOutcome {
  /** This start bound the working account for the first time (`BOUND`). */
  readonly bound: boolean;
  /** Why the start failed after (or before) the account check; null: connected. */
  readonly failure: { readonly error: unknown } | null;
}

/**
 * Connects and checks the account right after getMe (D-52 r2, review I-4): MISMATCH and
 * UNBOUND_HISTORY stop for good (r2 L-B, fatal errors). A first binding (`BOUND`) is already
 * written when the check returns, so its `accountBound` alert goes out whatever the rest of the
 * start does (r3, review CR-1): a later step such as warming the peers may still fail, and the
 * retry then sees MATCH and would never alert. `alerts.send` never throws; an alert it could not
 * queue is kept and retried on every lock tick.
 */
export async function startAndCheckAccount(
  client: Pick<BankFeedListenerClient, 'start'>,
  account: Pick<BankFeedAccountRepository, 'check'>,
  alerts: Pick<ListenerAlerts, 'send'>,
  now: () => Date,
): Promise<StartOutcome> {
  let bound = false;
  let failure: StartOutcome['failure'] = null;
  try {
    await client.start(async (accountId) => {
      const result = await account.check(accountId);
      if (result === 'MISMATCH') throw new BankFeedFatalError('ACCOUNT_MISMATCH');
      if (result === 'UNBOUND_HISTORY') throw new BankFeedFatalError('ACCOUNT_UNBOUND');
      bound = result === 'BOUND';
    });
  } catch (error) {
    failure = { error };
  }
  if (bound) await alerts.send('accountBound', alertRef.accountBound(now()));
  return { bound, failure };
}
