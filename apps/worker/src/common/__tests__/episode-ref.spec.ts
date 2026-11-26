import { notifyJobId, notifyJobSchema, type FulfillmentAlertKind } from '@repo/shared';
import { abandonedAlertRef } from '../../fulfillment/fulfill-settle';
import * as reconcilerNames from '../../reconcile/orders/guard-ref';
import {
  episodeAlert,
  episodeRef,
  walletBlockedRef,
  type EpochScope,
  type GuardScope,
} from '../episode-ref';

// S9i (S9e audit N-3): the episode refIds have one home, shared by the reconciler (database clock)
// and the fulfill settle (process clock). Their formats are pinned here as LITERAL ids: a notify job
// id is deduped for 30 days, so a changed format would re-send every episode already heard, and an
// id the settle builds differently from the reconciler would be heard twice (mutant: the format).

const ORDER = 'cmh1orderid0000000000001';
const TRANSFER = 'cmh1transfer000000000001';
/** 2026-11-16T10:20:00Z: hour 498562, day 20773 since the epoch. */
const AT = 1_794_824_400_000;
const SIX_HOURS = 6 * 3_600_000;

const PINNED: readonly (readonly [EpochScope, string, FulfillmentAlertKind])[] = [
  ['review', `${ORDER}_review_498562`, 'reconcileGuardRefused'],
  ['ton', `${ORDER}_ton_498562`, 'reconcileGuardRefused'],
  ['cu', `${TRANSFER}_cu_498562`, 'tonConsumedUnmatched'],
  ['lock', `${ORDER}_lock_498562`, 'needsReview'],
  ['abandoned', `${ORDER}_abandoned_20773`, 'needsReview'],
  ['held', `${ORDER}_held_498562`, 'reconcileGuardRefused'],
  ['heldlate', `${ORDER}_heldlate_20773`, 'reconcileGuardRefused'],
  ['heldlive', `${ORDER}_heldlive_20773`, 'reconcileGuardRefused'],
];

function jobIdOf(alert: FulfillmentAlertKind, refId: string): string {
  return notifyJobId(notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert, refId }));
}

describe('episode refIds (common/episode-ref.ts)', () => {
  it.each(PINNED)(
    '%s: the literal ref and notify job id stay as they were',
    (scope, ref, alert) => {
      const subject = ref.split('_')[0] ?? '';
      expect(episodeRef(subject, scope, AT)).toBe(ref);
      expect(episodeAlert(scope)).toBe(alert);
      expect(jobIdOf(alert, ref)).toBe(`alert-${alert}-${ref}`);
    },
  );

  it('wb: whole 6-hour periods since the block, the literal ref and job id', () => {
    const ref = `${TRANSFER}_wb_1`;
    expect(walletBlockedRef(TRANSFER, AT, AT + SIX_HOURS)).toBe(ref);
    expect(episodeAlert('wb' satisfies GuardScope)).toBe('tonWalletBlocked');
    expect(jobIdOf('tonWalletBlocked', ref)).toBe(`alert-tonWalletBlocked-${ref}`);
  });

  it('the settle builds the reconciler id for a used-up order: one notify job id for both', () => {
    const ref = `${ORDER}_abandoned_20773`;
    expect(abandonedAlertRef(ORDER, AT)).toBe(ref);
    expect(jobIdOf('needsReview', abandonedAlertRef(ORDER, AT))).toBe(
      jobIdOf('needsReview', episodeRef(ORDER, 'abandoned', AT) ?? ''),
    );
  });

  it('the reconciler uses the same functions, not a copy', () => {
    expect(reconcilerNames.episodeRef).toBe(episodeRef);
    expect(reconcilerNames.walletBlockedRef).toBe(walletBlockedRef);
    expect(reconcilerNames.episodeAlert).toBe(episodeAlert);
  });
});
