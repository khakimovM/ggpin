// Users fixtures (AdminOps.dc.html `users`, `user`), parsed with the shared schemas at load.
import {
  AdminUserDetailResponseSchema,
  AdminUserLedgerResponseSchema,
  AdminUserReferralsResponseSchema,
  AdminUserRowSchema,
  AdminUserSessionsResponseSchema,
  type AdminRole,
  type AdminUserDetailResponse,
  type AdminUserRow,
} from '@repo/shared';
import { ago, mid } from './data-common';

type Status = 'ACTIVE' | 'BLOCKED' | 'FROZEN' | 'BOT_BLOCKED';
const SAMPLE: [string, string, 'uz' | 'ru', number, number, string, number, number, Status][] = [
  ['1187712645', 'sardor_r', 'uz', 360_000, 2, '85400', 48, 7, 'ACTIVE'],
  ['5409918822', 'jasur_t', 'uz', 49_000, 60, '12000', 6, 0, 'ACTIVE'],
  ['7731004521', 'dilnoza_k', 'ru', 52_000, 15, '4300', 11, 2, 'ACTIVE'],
  ['6620019384', 'bek_99', 'uz', 109_000, 0, '1276500', 22, 0, 'FROZEN'],
  ['8120031177', 'nilu_r', 'ru', 38_000, 180, '0', 3, 0, 'ACTIVE'],
  ['5011223344', 'madina_a', 'uz', 45_000, 1_440, '31000', 9, 1, 'ACTIVE'],
  ['6098712233', 'spam_bot88', 'ru', 30_000, 2_880, '0', 0, 0, 'BLOCKED'],
  ['5523310987', 'otabek', 'uz', 72_000, 30, '154000', 15, 3, 'ACTIVE'],
  ['7001234567', 'kamola_m', 'uz', 21_000, 300, '9000', 2, 0, 'BOT_BLOCKED'],
  ['6512345098', 'akmal_s', 'uz', 98_000, 45, '-12000', 31, 4, 'ACTIVE'],
];

export const USERS: readonly AdminUserRow[] = SAMPLE.map(
  ([telegramId, username, locale, regAgo, seenAgo, balance, orders, refs, status], index) =>
    AdminUserRowSchema.parse({
      id: mid('user', index + 1),
      telegramId,
      username,
      firstName: index === 0 ? 'Sardor' : null,
      locale,
      createdAt: ago(regAgo * 4),
      lastSeenAt: ago(seenAgo),
      balanceTiyin: balance === '0' ? '0' : `${balance}00`,
      ordersCount: orders,
      ordersTotalTiyin: orders === 0 ? '0' : `${orders * 100_250}00`,
      referralsCount: refs,
      isBlocked: status === 'BLOCKED',
      purchaseFrozen: status === 'FROZEN',
      botBlocked: status === 'BOT_BLOCKED',
    }),
);

export function userDetailFixture(user: AdminUserRow, role: AdminRole): AdminUserDetailResponse {
  // SUPPORT sees the phone masked (users.phoneFull); the panel shows what the API sends.
  const phone = role === 'SUPPORT' ? '+998 ** *** ** 67' : '+998 90 123 45 67';
  return AdminUserDetailResponseSchema.parse({
    ...user,
    lastName: user.firstName ? 'Rahimov' : null,
    photoUrl: null,
    phone,
    referralCode: 'SARDOR7',
    referredBy: null,
    activeSessionsCount: 2,
    notes: [],
  });
}

export const USER_LEDGER = AdminUserLedgerResponseSchema.parse(
  (
    [
      ['PURCHASE', '-11000000', 'ORDER', 'ord', 7],
      ['TOPUP', '5000000', 'PAYMENT', 'pay', 14],
      ['REFERRAL_BONUS', '120700', 'REFERRAL', 'ref', 120],
      ['REFUND', '12075000', 'ORDER', 'ord', 1_020],
      ['PURCHASE', '-12075000', 'ORDER', 'ord', 1_100],
      ['TOPUP', '20000000', 'PAYMENT', 'pay', 1_200],
    ] as const
  ).map(([kind, amountTiyin, refType, ref, minutes], index) => ({
    id: mid('led', index + 1),
    kind,
    amountTiyin,
    refType,
    refId: mid(ref, index + 1),
    createdAt: ago(minutes),
  })),
);

export const USER_REFERRALS = AdminUserReferralsResponseSchema.parse(
  ['dilnoza_k', 'jasur_t', 'madina_a'].map((username, index) => ({
    id: mid('user', index + 2),
    username,
    createdAt: ago(40_000 + index * 3_000),
  })),
);

export const USER_SESSIONS = AdminUserSessionsResponseSchema.parse([
  {
    id: mid('uses', 1),
    userAgent: 'Chrome · Windows',
    ipMasked: '84.54.xx.12',
    createdAt: ago(300),
    expiresAt: ago(-43_000),
    revokedAt: null,
  },
  {
    id: mid('uses', 2),
    userAgent: 'Safari · iPhone',
    ipMasked: '95.214.xx.81',
    createdAt: ago(5_000),
    expiresAt: ago(-38_000),
    revokedAt: null,
  },
  {
    id: mid('uses', 3),
    userAgent: null,
    ipMasked: null,
    createdAt: ago(60_000),
    expiresAt: ago(-3_000),
    revokedAt: ago(20_000),
  },
]);
