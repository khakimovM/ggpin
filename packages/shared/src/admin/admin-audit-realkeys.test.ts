// S4 SA info + SA-S4-7 (phase 9 S6): every key a real audit writer puts in `before` / `after`
// today, with the category the redaction must give it. A writer that adds a key adds it here; a
// classifier change that moves a real key (a count hidden as a secret, a note hidden as bank
// text) fails this test instead of silently blanking the audit log.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_REDACTED,
  isAuditBankMessageKey,
  isAuditIpKey,
  isAuditOsUserKey,
  isAuditSecretKey,
  isAuditTelegramIdKey,
  redactAuditJson,
  type AuditRedactionView,
} from './index';

type Category = 'VISIBLE' | 'SECRET' | 'IP' | 'TG' | 'OSUSER' | 'BANK';

function categoryOf(key: string): Category {
  if (isAuditSecretKey(key)) return 'SECRET';
  if (isAuditIpKey(key)) return 'IP';
  if (isAuditTelegramIdKey(key)) return 'TG';
  if (isAuditOsUserKey(key)) return 'OSUSER';
  if (isAuditBankMessageKey(key)) return 'BANK';
  return 'VISIBLE';
}

/** The keys that are NOT plainly visible, and why. */
const HIDDEN: Readonly<Record<string, Category>> = {
  telegramId: 'TG',
  osUser: 'OSUSER',
  ipMasked: 'IP',
  // The card's verification transfer: whoever knows it can make the card ACTIVE (D-37).
  verifyAmountTiyin: 'SECRET',
  // A bank message's raw text (OWNER only); a note's `text` is decided by its action below.
  text: 'BANK',
  // The admin request's body hash (docs/04: never in a response).
  requestHash: 'SECRET',
};

// grep of every auditLog.create / createAudit / writeAudit in apps/api and apps/worker
// (SA probe realkeys.probe.mts), plus the S6 admin writers (adminRole, requestHash, isBlocked,
// sessionId). LIMITATION (C-8 / SA-S6-13, stated plainly): this list is kept by hand. It cannot be
// built from the writers' exports or a source scan: most keys reach `before` / `after` through
// spreads of computed objects (`...json(card)`, `...changed.extra`, `...who`), which a text
// scan cannot see and the writers do not export as constants. A writer that adds a key and does
// not add it here is NOT caught by this test; the safety net is that the classifier fails closed
// for secret-looking names (admin-audit-keys.ts) and code review of every new audit field.
const REAL_KEYS = [
  'telegramId',
  'name',
  'role',
  'isActive',
  'allowlisted',
  'operator',
  'osUser',
  'revokedSessions',
  'expiredLoginCodes',
  'lastOwnerConfirmed',
  'device',
  'ipMasked',
  'expiresAt',
  'source',
  'adminRole',
  'actorId',
  'actorType',
  'action',
  'targetType',
  'targetId',
  'from',
  'to',
  'limit',
  'status',
  'receiveLimitTiyin',
  'monthlyLimitTiyin',
  'autoCreditPaused',
  'bank',
  'last4',
  'verifyAmountTiyin',
  'cancelledIntents',
  'alreadyPaused',
  'openPauseReviews',
  'override',
  'liftedPause',
  'reason',
  'ref',
  'bornPaused',
  'kind',
  'intentStatus',
  'resolution',
  'paymentId',
  'userId',
  'intentId',
  'amountTiyin',
  'otpVerified',
  'user',
  'blocked',
  'purchaseFrozen',
  'accountAgeSec',
  'usedBaseTiyin',
  'requestedBaseTiyin',
  'limitTiyin',
  'limitReason',
  'overLimit',
  'bankVerified',
  'cardId',
  'autoCreditResumed',
  'remainingPauseReasons',
  'balanceTiyin',
  'recentAutoTopups',
  'openOrders',
  'paymentStatus',
  'reversedTiyin',
  'retiredAt',
  'count',
  'debits',
  'openReviews',
  'historyScan',
  'history',
  'HUMO_BOT',
  'UZCARD_BOT',
  'state',
  'fetched',
  'recovered',
  'window',
  'since',
  'until',
  'checkedMessages',
  'mismatches',
  'examples',
  'debitsByCard',
  'sumTiyin',
  'chainBreaksReviewed',
  'possibleReversals',
  'graceEnded',
  'missingOutcome',
  'creditUnaccounted',
  'paymentWithoutMessage',
  'chainBreak',
  'pendingPastGrace',
  'lateOverLimit',
  'reviewOpenOver24h',
  'purgeOverdue',
  'unknownCard',
  'text',
  'txHash',
  'extMsgHash',
  'consumingTxHash',
  'returnTxHash',
  'lt',
  'proofDigest',
  'requestHash',
  'isBlocked',
  'sessionId',
  // Phase 9 S8a, the catalog writes (admin-catalog-write.results.ts field lists + the reorder).
  'nameUz',
  'nameRu',
  'descriptionUz',
  'descriptionRu',
  'helpUz',
  'helpRu',
  'regionBadge',
  'imageUrl',
  'isFeatured',
  'sort',
  'skuId',
  'tab',
  'labelUz',
  'labelRu',
  'quantity',
  'supplierSku',
  'markupBps',
  'minMarginTiyin',
  'priority',
  'isEnabled',
  'sorts',
  'id',
  // Phase 9 S9a, the panel's admin management (admin-panel-accounts.service.ts).
  'currentRevoked',
  'adminId',
] as const;

const VIEW: AuditRedactionView = {
  ipFull: false,
  bankMessageRaw: false,
  identityFull: false,
  maskIp: () => '203.0.113.x',
  maskTelegramId: () => '12******89',
};

describe('real audit writer keys (S4 SA info)', () => {
  it.each(REAL_KEYS.map((key) => [key, HIDDEN[key] ?? 'VISIBLE'] as const))(
    '%s is %s',
    (key, expected) => {
      expect(categoryOf(key)).toBe(expected);
    },
  );

  it('expiredLoginCodes is a plain count, shown to the owner as written', () => {
    const owner = { ...VIEW, ipFull: true, bankMessageRaw: true, identityFull: true };
    expect(redactAuditJson({ expiredLoginCodes: 3 }, owner)).toEqual({ expiredLoginCodes: 3 });
  });
});

describe('note text vs bank text (SA-S4-7)', () => {
  it('a USER_NOTE / ORDER_NOTE text is shown to a reader without bankMessageRaw', () => {
    for (const action of ['USER_NOTE', 'ORDER_NOTE']) {
      expect(redactAuditJson({ text: 'called the user' }, VIEW, action)).toEqual({
        text: 'called the user',
      });
    }
  });

  it('any other row keeps text for the owner only; secrets stay redacted in a note', () => {
    expect(redactAuditJson({ text: 'Humo: +1 000' }, VIEW, 'PAYMENT_RECONCILE')).toEqual({
      text: null,
    });
    expect(redactAuditJson({ text: 'Humo: +1 000' }, VIEW)).toEqual({ text: null });
    expect(redactAuditJson({ text: 'x', requestHash: 'h' }, VIEW, 'USER_NOTE')).toEqual({
      text: 'x',
      requestHash: AUDIT_REDACTED,
    });
  });

  it('only the top-level text of a note row is the note', () => {
    expect(redactAuditJson({ inner: { text: 'raw' } }, VIEW, 'USER_NOTE')).toEqual({
      inner: { text: null },
    });
  });
});
