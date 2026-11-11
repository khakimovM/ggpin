import { Logger } from '@nestjs/common';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import type { AutoCreditPauser } from './auto-credit-pauser';
import type { BankFeedAccountRepository } from './bank-feed-account.repository';
import type { BankFeedAuthorization } from './bank-feed-client';

export type AuthorizationsVerdict = 'BASELINE_PAUSED' | 'UNCHANGED' | 'NEW_PAUSED';

const HOUR_MS = 3_600_000;

/**
 * `account.getAuthorizations` on every round (docs/05 §4): an authorization not seen before means
 * someone else may be logged in to the working account. The known ones live in Postgres
 * (BankFeedAuthorization, D-52 D1). Then, in this order (D-52, review I4): the owner alert first
 * (`newAuthorization`, refId = the hash, so a retry adds nothing), then auto-credit is paused on
 * ALL cards (fail closed; credits go to review AUTO_CREDIT_PAUSED until the owner checks the
 * sessions and runs `card:resume`), and only then the hashes are remembered. A failure anywhere
 * throws before they are remembered, so the next round does it all again; the alert is out even
 * when the pause failed.
 *
 * An EMPTY table is never a silent baseline (D-52 D1): the first start, or a table someone
 * emptied, alerts `authorizationsBaseline` (refId = the hour), pauses everything the same way and
 * records the current list; the owner checks the sessions and resumes.
 * Logs carry counts only: never an IP, a country, a region or a device.
 */
export class AuthorizationsWatch {
  private readonly logger = new Logger(AuthorizationsWatch.name);

  constructor(
    private readonly known: Pick<BankFeedAccountRepository, 'knownHashes' | 'remember'>,
    private readonly pauser: Pick<AutoCreditPauser, 'pauseAll'>,
    private readonly notifier: Pick<BankFeedNotifier, 'alert'>,
  ) {}

  async check(
    list: readonly BankFeedAuthorization[],
    now: Date = new Date(),
  ): Promise<AuthorizationsVerdict> {
    const seen = await this.known.knownHashes();
    if (seen.size === 0) {
      const ref = String(Math.floor(now.getTime() / HOUR_MS));
      await this.notifier.alert('authorizationsBaseline', ref);
      const paused = await this.pauser.pauseAll({ reason: 'AUTH_BASELINE', ref });
      await this.known.remember(list);
      this.logger.error(
        `bank-feed authorizations recorded with no baseline: count=${String(list.length)}; ` +
          `auto-credit newly paused on ${String(paused)} card(s)`,
      );
      return 'BASELINE_PAUSED';
    }
    const fresh = list.filter((a) => !seen.has(a.hash));
    if (fresh.length === 0) return 'UNCHANGED';
    for (const authorization of fresh) {
      await this.notifier.alert('newAuthorization', authorization.hash);
    }
    // The pause's AuditLog rows name the first new hash (the alert refId of that session).
    const ref = fresh[0]?.hash ?? 'unknown';
    const paused = await this.pauser.pauseAll({ reason: 'NEW_AUTHORIZATION', ref });
    await this.known.remember(fresh);
    this.logger.error(
      `new authorization on the bank-feed account: count=${String(fresh.length)}; ` +
        `auto-credit paused on ${String(paused)} card(s)`,
    );
    return 'NEW_PAUSED';
  }
}
