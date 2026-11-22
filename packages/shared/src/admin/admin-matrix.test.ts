// The whole admin role matrix as an exact inline table (review SA-L3): any change to who may do
// what, when the code is asked or where OPERATOR's limit applies shows up here as a diff a human
// must approve. O = OWNER, P = OPERATOR, S = SUPPORT. Source: D-63 (3)/(4) with D-65 D1–D4, D-66 and p5 S9a.
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, ADMIN_PERMISSION_KEYS, type AdminOtpRule } from './admin-permissions';

// holds: owner-only holds for OPERATOR — C = ATTEMPT_CAP, N = NO_PURCHASE (M-1, D-64 (6)).
type Row = readonly [
  key: string,
  roles: string,
  otp: AdminOtpRule,
  operatorLimit: boolean,
  holds: string,
];

const EXPECTED: readonly Row[] = [
  ['dashboard.read', 'OP', 'NEVER', false, ''],
  ['orders.read', 'OPS', 'NEVER', false, ''],
  ['users.read', 'OPS', 'NEVER', false, ''],
  ['users.phoneFull', 'OP', 'NEVER', false, ''],
  ['payments.read', 'OPS', 'NEVER', false, ''],
  ['payments.creditPreview', 'O', 'NEVER', false, ''],
  ['payments.bankMessageRaw', 'O', 'NEVER', false, ''],
  ['catalog.read', 'OP', 'NEVER', false, ''],
  ['settings.read', 'OP', 'NEVER', false, ''],
  ['audit.read', 'OP', 'NEVER', false, ''],
  ['audit.ipFull', 'O', 'NEVER', false, ''],
  ['audit.export', 'O', 'NEVER', false, ''],
  ['infra.read', 'OP', 'NEVER', false, ''],
  ['admins.read', 'O', 'NEVER', false, ''],
  ['orders.note', 'OPS', 'NEVER', false, ''],
  ['orders.retry', 'OP', 'NEVER', false, 'CN'],
  ['orders.cancel', 'OP', 'ABOVE_THRESHOLD', true, 'N'],
  ['orders.failAndRefund', 'OP', 'ABOVE_THRESHOLD', true, 'N'],
  ['orders.resolve', 'O', 'RULE_OR_ABOVE_THRESHOLD', false, ''],
  ['orders.refund', 'O', 'ALWAYS', false, ''],
  ['users.note', 'OPS', 'NEVER', false, ''],
  ['users.block', 'OP', 'NEVER', false, ''],
  ['users.unblock', 'O', 'NEVER', false, ''],
  ['users.freeze', 'OP', 'NEVER', false, ''],
  ['users.unfreeze', 'O', 'NEVER', false, ''],
  ['users.sessionsRevoke', 'OP', 'NEVER', false, ''],
  ['users.adjustWallet', 'O', 'CREDIT_ALWAYS_ELSE_ABOVE_THRESHOLD_OR_DAILY', false, ''],
  ['payments.reviewCredit', 'O', 'ALWAYS', false, ''],
  ['payments.reverse', 'O', 'ABOVE_THRESHOLD_OR_DAILY', false, ''],
  ['cards.pause', 'O', 'NEVER', false, ''],
  ['cards.resume', 'O', 'RULE', false, ''],
  ['cards.limit', 'O', 'RULE', false, ''],
  ['cards.retire', 'O', 'ALWAYS', false, ''],
  ['catalog.categoryUpdate', 'O', 'NEVER', false, ''],
  ['catalog.productUpdate', 'O', 'NEVER', false, ''],
  ['catalog.productReorder', 'O', 'NEVER', false, ''],
  ['catalog.skuCreate', 'O', 'NEVER', false, ''],
  ['catalog.skuUpdate', 'O', 'NEVER', false, ''],
  ['catalog.routeUpdate', 'O', 'NEVER', false, ''],
  ['fx.set', 'O', 'RULE', false, ''],
  ['admins.create', 'O', 'ALWAYS', false, ''],
  ['admins.update', 'O', 'ALWAYS', false, ''],
  ['admins.sessionsRevoke', 'O', 'ALWAYS', false, ''],
  ['sessions.revoke', 'O', 'ALWAYS', false, ''],
  ['queues.retry', 'O', 'NEVER', false, ''],
  ['confirmations.create', 'OP', 'NEVER', false, ''],
];

const LETTER = { OWNER: 'O', OPERATOR: 'P', SUPPORT: 'S' } as const;
const HOLD = { ATTEMPT_CAP: 'C', NO_PURCHASE: 'N' } as const;

describe('admin role matrix snapshot', () => {
  it('equals the approved table row by row', () => {
    const actual: Row[] = ADMIN_PERMISSION_KEYS.map((key) => {
      const rule = ADMIN_PERMISSIONS[key];
      const holds = rule.ownerOnlyHolds.map((h) => HOLD[h]).join('');
      return [key, rule.roles.map((r) => LETTER[r]).join(''), rule.otp, rule.operatorLimit, holds];
    });
    expect(actual).toEqual(EXPECTED);
  });
});
