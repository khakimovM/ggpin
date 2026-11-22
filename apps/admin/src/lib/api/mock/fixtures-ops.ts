// Infra, audit and admins fixtures (AdminOps.dc.html `queues`, `wallet`, `fragment`, `audit`,
// `admins`). Wallet and Fragment have no API before S11; queues, audit and admins do.
import {
  AdminAccountListResponseSchema,
  AdminAuditListResponseSchema,
  AdminInfraFragmentResponseSchema,
  AdminInfraQueuesResponseSchema,
  AdminInfraWalletResponseSchema,
  AdminSessionListResponseSchema,
  QUEUES,
} from '@repo/shared';
import { ago, mid } from './data-common';

const COUNTS: Record<string, [number, number, number, number]> = {
  [QUEUES.FULFILL_ORDER]: [4, 2, 0, 1],
  [QUEUES.TG_OUTBOX]: [12, 1, 0, 3],
  [QUEUES.NOTIFY]: [0, 0, 0, 0],
  [QUEUES.BANK_MESSAGE]: [0, 1, 0, 0],
  [QUEUES.PRICE_SYNC]: [0, 0, 1, 0],
  [QUEUES.RECONCILE]: [0, 0, 1, 0],
};

export const QUEUE_ROWS = AdminInfraQueuesResponseSchema.parse(
  Object.values(QUEUES).map((name) => {
    const [waiting, active, delayed, failed] = COUNTS[name] ?? [0, 0, 0, 0];
    return {
      name,
      waiting,
      active,
      delayed,
      failed,
      paused: false,
      retryable: name === QUEUES.NOTIFY || name === QUEUES.TG_OUTBOX,
    };
  }),
);

export const WALLET = AdminInfraWalletResponseSchema.parse({
  network: 'testnet',
  address: 'UQAi7Kx0hotWalletMockAddress00000000000000000ax9F',
  balance: { nanoTon: '182400000000', microUsdt: '1240000000', snapshotAt: ago(1) },
  used24hNanoTon: '61200000000',
  limits: {
    perOrderMaxNanoTon: '25000000000',
    dailyMaxNanoTon: '100000000000',
    minBalanceAlertNanoTon: '50000000000',
  },
  recentTransfers: (
    [
      ['CONFIRMED', '3920000000', 2],
      ['BROADCAST', '1960000000', 3],
      ['CONFIRMED', '4300000000', 18],
      ['EXPIRED', '980000000', 75],
      ['CONFIRMED', '9800000000', 130],
    ] as const
  ).map(([status, amountNanoTon, minutes], index) => ({
    id: mid('ton', index + 1),
    orderId: mid('ord', index + 1),
    status,
    amountNanoTon,
    txHash: status === 'CONFIRMED' ? `${'7cc0'.padEnd(60, String(index))}11be` : null,
    explorerUrl: null,
    createdAt: ago(minutes),
  })),
});

export const FRAGMENT = AdminInfraFragmentResponseSchema.parse({
  status: 'ACTIVE',
  lastOkAt: ago(1),
  deadAt: null,
  updatedAt: ago(1),
});

export const AUDIT = AdminAuditListResponseSchema.parse([
  {
    id: mid('aud', 1),
    createdAt: ago(3),
    actor: { type: 'ADMIN', id: mid('adm', 1), name: 'Aziz O.' },
    action: 'ORDER_REFUND',
    targetType: 'Order',
    targetId: mid('ord', 6),
    before: { status: 'FAILED', refundedTiyin: '0' },
    after: { status: 'REFUNDED', refundedTiyin: '1290000000' },
    reason: 'Ta’minotchi kodni bermadi',
    ip: '84.54.xx.12',
  },
  {
    id: mid('aud', 2),
    createdAt: ago(42),
    actor: { type: 'ADMIN', id: mid('adm', 2), name: 'Dilshod K.' },
    action: 'USER_FREEZE',
    targetType: 'User',
    targetId: mid('user', 4),
    before: { purchaseFrozen: false },
    after: { purchaseFrozen: true },
    reason: 'Shubhali to‘lovlar',
    ip: '95.214.xx.81',
  },
  {
    id: mid('aud', 3),
    createdAt: ago(130),
    actor: { type: 'SYSTEM', id: null, name: null },
    action: 'PAYMENT_RECONCILE',
    targetType: 'ReconcileReport',
    targetId: '2026-11-17',
    before: null,
    after: { ok: false, creditUnaccounted: 1 },
    reason: null,
    ip: null,
  },
  {
    id: mid('aud', 4),
    createdAt: ago(600),
    actor: { type: 'CLI', id: null, name: 'aziz' },
    action: 'ADMIN_CREATE',
    targetType: 'AdminUser',
    targetId: mid('adm', 3),
    before: null,
    after: { role: 'SUPPORT', name: 'Malika R.' },
    reason: 'Yangi operator',
    ip: null,
  },
]);

export const ADMINS = AdminAccountListResponseSchema.parse(
  (
    [
      ['Aziz O.', '1187700001', 'OWNER', true, 4, 2],
      ['Dilshod K.', '5409900002', 'OPERATOR', true, 30, 1],
      ['Malika R.', '7731000003', 'SUPPORT', true, 300, 1],
      ['Temur S.', '6620000004', 'OPERATOR', false, 40_000, 0],
    ] as const
  ).map(([name, telegramId, role, isActive, minutes, sessions], index) => ({
    id: mid('adm', index + 1),
    telegramId,
    name,
    role,
    isActive,
    allowlisted: isActive,
    lastLoginAt: ago(minutes),
    activeSessions: sessions,
    createdAt: ago(90_000 - index * 10_000),
  })),
);

export function adminSessionsFixture(adminId: string) {
  const admin = ADMINS.find((one) => one.id === adminId);
  const count = admin?.activeSessions ?? 0;
  return AdminSessionListResponseSchema.parse(
    Array.from({ length: count }, (_, index) => ({
      id: `${adminId}s${index}`,
      createdAt: ago(60 + index * 200),
      lastUsedAt: ago(index * 30 + 1),
      expiresAt: ago(-420 + index * 200),
      idleExpiresAt: ago(-59),
      revokedAt: null,
      ipMasked: index === 0 ? '84.54.xx.12' : '95.214.xx.81',
      userAgent: index === 0 ? 'Chrome · Windows' : 'Safari · macOS',
      current: adminId === mid('adm', 1) && index === 0,
    })),
  );
}
