// Golden test of the audit redactor (review M-2 / N2) over the `before` / `after` shapes the
// services really write. Sources: main — wallet-admin(.reverse).service.ts, review-credit.service.ts
// (+ review-credit.checks.ts userCheckAudit), card-admin.service.ts / card-pause.service.ts,
// worker security-pause.repository.ts; p5 (origin/feat/p5-stars-order) — fx-admin.service.ts,
// order-retry.service.ts (+ S9a `maxAttemptNo`, `actor.role`), packages/db needs-review-resolve.ts
// with the review-proof.ts proof kinds. Two-sided: every key of a shape is listed as visible or
// hidden, so a new field forces a decision here.
import { describe, expect, it } from 'vitest';
import * as a from './index';

type Json = Record<string, unknown>;

const OWNER_VIEW: a.AuditRedactionView = {
  ipFull: true,
  bankMessageRaw: true,
  maskIp: () => 'masked',
  identityFull: true,
  maskTelegramId: () => 'masked',
};
const HASH = 'a'.repeat(64);
const cli = { operator: 'aziz', osUser: 'deploy' };
/** `'a b.c'` → `['a', 'b.c']`: the path lists stay one line per group. */
const paths = (text: string): string[] => text.split(/\s+/).filter((path) => path !== '');

const isPlain = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Paths of the leaf keys (a hidden key counts as a leaf: its subtree is gone). */
function leafPaths(value: Json, hidden: ReadonlySet<string>, path = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path === '' ? key : `${path}.${key}`;
    return isPlain(child) && !hidden.has(here) ? leafPaths(child, hidden, here) : [here];
  });
}

const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (isPlain(node) ? node[key] : undefined), value);

interface Golden {
  readonly name: string;
  readonly json: Json;
  readonly visible: string;
  readonly hidden: string;
}

const cardJson = {
  status: 'ACTIVE',
  receiveLimitTiyin: '1',
  monthlyLimitTiyin: null,
  autoCreditPaused: false,
};
const cardPaths = (side: string): string =>
  Object.keys(cardJson)
    .map((key) => `${side}.${key}`)
    .join(' ');

const GOLDEN: readonly Golden[] = [
  {
    name: 'WALLET_ADJUST',
    json: {
      before: { balanceTiyin: '100' },
      after: { balanceTiyin: '2', ...cli, otpVerified: true, override: true, recentAutoTopups: [] },
    },
    visible: `before.balanceTiyin after.balanceTiyin after.operator after.osUser
      after.otpVerified after.override after.recentAutoTopups`,
    hidden: '',
  },
  {
    name: 'PAYMENT_REVERSE',
    json: {
      before: { balanceTiyin: '200', paymentStatus: 'CONFIRMED' },
      after: { balanceTiyin: '1', paymentStatus: 'CANCELLED', reversedTiyin: '1', ...cli },
    },
    visible: `before.balanceTiyin before.paymentStatus after.balanceTiyin after.paymentStatus
      after.reversedTiyin after.operator after.osUser`,
    hidden: '',
  },
  {
    name: 'REVIEW_CREDIT',
    json: {
      before: { status: 'OPEN', kind: 'UNMATCHED', intentStatus: null },
      after: {
        status: 'RESOLVED',
        resolution: 'CREDITED_USER',
        paymentId: 'p1',
        userId: 'u1',
        intentId: null,
        amountTiyin: '5000',
        otpVerified: true,
        user: { blocked: false, accountAgeSec: 9, limitReason: 'NEW', overLimit: false },
        override: false,
        bankVerified: true,
        ...cli,
      },
    },
    visible: `before.status before.kind before.intentStatus after.status after.resolution
      after.paymentId after.userId after.intentId after.amountTiyin after.otpVerified
      after.user.blocked after.user.accountAgeSec after.user.limitReason after.user.overLimit
      after.override after.bankVerified after.operator after.osUser`,
    hidden: '',
  },
  {
    name: 'FX_SET',
    json: {
      before: { previous: { id: 'f1', rate: '12700', source: 'CBU' } },
      after: {
        pair: 'USDT_UZS',
        rate: '12800',
        source: 'MANUAL',
        derived: null,
        derivedSkip: null,
        flags: ['JUMP'],
        ...cli,
        otpVerified: true,
      },
    },
    visible: `before.previous.id before.previous.rate before.previous.source after.pair
      after.rate after.source after.derived after.derivedSkip after.flags after.operator
      after.osUser after.otpVerified`,
    hidden: '',
  },
  {
    name: 'ORDER_REVIEW_RESOLVE (TON_BOUNCED)',
    json: {
      before: { status: 'NEEDS_REVIEW', statusReason: 'TON_UNCONFIRMED' },
      after: {
        proof: {
          kind: 'TON_BOUNCED',
          transferId: 'c1',
          txHash: HASH,
          txLt: '10',
          returnTxHash: HASH,
          returnLt: '11',
          returnedNanoTon: '5',
          reason: 'Qaytdi, tekshirildi',
        },
        resolver: 'operator',
        operator: { type: 'ADMIN', id: 'a1', role: 'OWNER' },
        osUser: null,
        otpVerified: true,
        acknowledgements: null,
        refund: { amountTiyin: '5000', ledgerEntryId: 'l1' },
      },
    },
    visible: `before.status before.statusReason after.proof.kind after.proof.transferId
      after.proof.txHash after.proof.txLt after.proof.returnTxHash after.proof.returnLt
      after.proof.returnedNanoTon after.proof.reason after.resolver after.operator.type
      after.operator.id after.operator.role after.osUser after.otpVerified
      after.acknowledgements after.refund.amountTiyin after.refund.ledgerEntryId`,
    hidden: '',
  },
  {
    name: 'ORDER_REVIEW_RESOLVE (TON_TX, TON_UNMATCHED_RESOLVED, FRAGMENT_STATUS)',
    json: {
      tx: { kind: 'TON_TX', extMsgHash: HASH, walletAddress: `0:${HASH}`, txHash: HASH, lt: '9' },
      unmatched: { kind: 'TON_UNMATCHED_RESOLVED', finding: 'NOT_SENT', consumingTxHash: HASH },
      fragment: { kind: 'FRAGMENT_STATUS', requestRef: 'r1', status: 'DONE', observedAt: 'x' },
      proofDigest: 'abcdef012345',
    },
    visible: `tx.kind tx.extMsgHash tx.walletAddress tx.txHash tx.lt unmatched.kind
      unmatched.finding unmatched.consumingTxHash fragment.kind fragment.requestRef
      fragment.status fragment.observedAt proofDigest`,
    hidden: '',
  },
  {
    name: 'ORDER_RETRY',
    json: {
      before: { status: 'HELD', statusReason: 'ATTEMPT_LIMIT', holdNote: null, maxAttemptNo: 3 },
      after: { status: 'QUEUED', ...cli, actor: { type: 'ADMIN', role: 'OWNER' } },
    },
    visible: `before.status before.statusReason before.holdNote before.maxAttemptNo after.status
      after.operator after.osUser after.actor.type after.actor.role`,
    hidden: '',
  },
  {
    name: 'CARD_ADD',
    json: { after: { ...cardJson, bank: 'HUMO', last4: '1234', verifyAmountTiyin: '137', ...cli } },
    visible: `${cardPaths('after')} after.bank after.last4 after.operator after.osUser`,
    hidden: 'after.verifyAmountTiyin',
  },
  {
    name: 'CARD_RESUME / CARD_RETIRE / CARD_PAUSE',
    json: {
      before: cardJson,
      after: {
        ...cardJson,
        openPauseReviews: 'r1',
        override: true,
        liftedPause: 'SECURITY_PAUSE/NEW_DEVICE',
        cancelledIntents: 2,
        alreadyPaused: false,
        ...cli,
      },
    },
    visible: `${cardPaths('before')} ${cardPaths('after')} after.openPauseReviews after.override
      after.liftedPause after.cancelledIntents after.alreadyPaused after.operator after.osUser`,
    hidden: '',
  },
  {
    name: 'SECURITY_PAUSE (worker)',
    json: {
      before: { autoCreditPaused: false },
      after: { autoCreditPaused: true, reason: 'NEW_DEVICE', ref: 'x', alreadyPaused: false },
    },
    visible:
      'before.autoCreditPaused after.autoCreditPaused after.reason after.ref after.alreadyPaused',
    hidden: '',
  },
  {
    name: 'secrets a writer must never leave in audit JSON',
    json: {
      ...Object.fromEntries(
        paths(`providerRef providerTxnId recheckedProviderRef raw cardPan pan idempotencyKey
          requestHash payTokenHash textSha256 signedBoc initData sessionString session otp code
          challengeId seed privateKey signature bonusCode`).map((key) => [key, 'x']),
      ),
      revokedSessions: 2,
    },
    visible: 'revokedSessions',
    hidden: `providerRef providerTxnId recheckedProviderRef raw cardPan pan idempotencyKey
      requestHash payTokenHash textSha256 signedBoc initData sessionString session otp code
      challengeId seed privateKey signature bonusCode`,
  },
];

describe('audit redaction golden shapes', () => {
  it.each(GOLDEN.map((g) => [g.name, g] as const))('%s', (_name, golden) => {
    const visible = paths(golden.visible);
    const hidden = paths(golden.hidden);
    expect(leafPaths(golden.json, new Set(hidden)).sort()).toEqual([...visible, ...hidden].sort());
    const out = a.redactAuditJson(golden.json, OWNER_VIEW);
    for (const path of visible) expect(at(out, path), path).toEqual(at(golden.json, path));
    for (const path of hidden) expect(at(out, path), path).toBe(a.AUDIT_REDACTED);
    expect(a.findAuditSecretPaths(out)).toEqual([]);
  });

  it('redacts inside arrays too', () => {
    expect(a.redactAuditJson({ nested: [{ api_key: 'x' }] }, OWNER_VIEW)).toEqual({
      nested: [{ api_key: a.AUDIT_REDACTED }],
    });
    expect(a.findAuditSecretPaths({ nested: [{ api_key: 'x' }] })).toEqual(['$.nested[0].api_key']);
  });

  it('fails closed on new secret-looking keys, by word and not by substring', () => {
    for (const key of paths(`fooSecret newMnemonic xCookie stel_token API-KEYS walletHash
      bonusCodes otpSent verifyAmountUzs tonBoc`)) {
      expect(a.isAuditSecretKey(key), key).toBe(true);
    }
    for (const key of paths('revokedSessions company panel phashion codex hashtag')) {
      expect(a.isAuditSecretKey(key), key).toBe(false);
    }
  });

  it('lets the allowlist win over every deny rule', () => {
    for (const key of a.AUDIT_VISIBLE_KEYS) expect(a.isAuditSecretKey(key), key).toBe(false);
    for (const key of a.AUDIT_SECRET_KEYS) expect(a.isAuditSecretKey(key), key).toBe(true);
    expect(a.isAuditSecretKey('OTP_VERIFIED')).toBe(false);
    expect(a.auditKeyTokens('payTokenHash')).toEqual(['pay', 'token', 'hash']);
    expect(a.auditKeyTokens('APIKey_value')).toEqual(['api', 'key', 'value']);
  });
});

describe('audit IP and bank message fields by role', () => {
  const row = {
    ip: '203.0.113.45',
    nested: { sshClient: '198.51.100.7 22 33', remote_addr: 7 },
    message: { text: 'Karta *1234 +50 000', rawText: 'x', balanceAfterTiyin: '1', channel: 'HUMO' },
  };
  const others: a.AuditRedactionView = {
    ipFull: false,
    bankMessageRaw: false,
    maskIp: (ip) => (ip.startsWith('203.') ? '203.0.113.x' : null),
    identityFull: false,
    maskTelegramId: () => '12***89',
  };

  it('masks IP fields and nulls the bank message fields for a non-owner', () => {
    expect(a.redactAuditJson(row, others)).toEqual({
      ip: '203.0.113.x',
      nested: { sshClient: null, remote_addr: null },
      message: { text: null, rawText: null, balanceAfterTiyin: null, channel: null },
    });
  });

  it('shows them as written to OWNER', () => {
    expect(a.redactAuditJson(row, OWNER_VIEW)).toEqual(row);
  });
});
