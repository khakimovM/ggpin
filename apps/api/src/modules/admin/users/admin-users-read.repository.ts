import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import type { AdminUserListQuery } from '@repo/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { dateRange } from '../read/admin-read-view';

/** `AuditLog.targetType` of a user note (`USER_NOTE`), the convention of the CLI's WALLET_ADJUST. */
export const USER_NOTE_TARGET = 'User';
export const USER_NOTES_SHOWN = 20;
const INT8_MAX = 9_223_372_036_854_775_807n;

export const ADMIN_USER_ROW_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  firstName: true,
  locale: true,
  createdAt: true,
  lastSeenAt: true,
  isBlocked: true,
  purchaseFrozen: true,
  botBlockedAt: true,
  _count: { select: { referrals: true } },
} as const satisfies Prisma.UserSelect;
export type AdminUserRowSource = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_ROW_SELECT }>;

const DETAIL_SELECT = {
  ...ADMIN_USER_ROW_SELECT,
  lastName: true,
  photoUrl: true,
  phone: true,
  referralCode: true,
  referredBy: { select: { id: true, username: true } },
} as const satisfies Prisma.UserSelect;
export type AdminUserDetailSource = Prisma.UserGetPayload<{ select: typeof DETAIL_SELECT }>;

/** `q`: `@username` exactly, a Telegram id or a user id (docs/04 «Foydalanuvchilar»). */
function searchWhere(q: string): Prisma.UserWhereInput {
  if (q.startsWith('@')) return { username: { equals: q.slice(1), mode: 'insensitive' } };
  const byId: Prisma.UserWhereInput[] = [{ id: q }];
  if (/^\d{1,19}$/.test(q) && BigInt(q) <= INT8_MAX) byId.push({ telegramId: BigInt(q) });
  else byId.push({ username: { equals: q, mode: 'insensitive' } });
  return { OR: byId };
}

const STATUS_WHERE: Record<NonNullable<AdminUserListQuery['status']>, Prisma.UserWhereInput> = {
  ACTIVE: { isBlocked: false, purchaseFrozen: false },
  BLOCKED: { isBlocked: true },
  FROZEN: { purchaseFrozen: true },
  BOT_BLOCKED: { botBlockedAt: { not: null } },
};

type Page = { skip: number; take: number };
const NEWEST = [
  { createdAt: 'desc' },
  { id: 'desc' },
] as const satisfies Prisma.UserOrderByWithRelationInput[];

// Every admin read of users and their tabs. The admin sees every user, so nothing here is scoped
// to an owner; each query names its columns, so a secret column (refresh hash, pay token) can
// never ride along.
@Injectable()
export class AdminUsersReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  async list(query: AdminUserListQuery, page: Page) {
    const where: Prisma.UserWhereInput = {
      AND: [
        query.q === undefined ? {} : searchWhere(query.q),
        query.status === undefined ? {} : STATUS_WHERE[query.status],
        { createdAt: dateRange(query) },
      ],
    };
    const [rows, total] = await this.db.$transaction([
      this.db.user.findMany({
        where,
        select: ADMIN_USER_ROW_SELECT,
        orderBy: [...NEWEST],
        ...page,
      }),
      this.db.user.count({ where }),
    ]);
    return { rows, total };
  }

  detail(id: string): Promise<AdminUserDetailSource | null> {
    return this.db.user.findUnique({ where: { id }, select: DETAIL_SELECT });
  }

  async exists(id: string): Promise<boolean> {
    return (await this.db.user.count({ where: { id } })) > 0;
  }

  /** Σ price and Σ discount of each user's DELIVERED orders (what they actually bought). */
  deliveredSums(userIds: readonly string[]) {
    return this.db.order.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] }, status: 'DELIVERED' },
      _sum: { priceTiyin: true, discountTiyin: true },
      _count: { _all: true },
    });
  }

  activeWebSessions(userId: string, now: Date): Promise<number> {
    return this.db.webSession.count({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
    });
  }

  /** The newest admin notes on the user (`USER_NOTE` audit rows) with their authors. */
  async notes(userId: string) {
    const rows = await this.db.auditLog.findMany({
      where: {
        action: 'USER_NOTE',
        actorType: 'ADMIN',
        targetType: USER_NOTE_TARGET,
        targetId: userId,
      },
      select: { id: true, actorId: true, after: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: USER_NOTES_SHOWN,
    });
    const authorIds = [
      ...new Set(rows.flatMap((row) => (row.actorId === null ? [] : [row.actorId]))),
    ];
    const authors = await this.db.adminUser.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true },
    });
    return { rows, authors: new Map(authors.map((a) => [a.id, a.name])) };
  }

  async ledger(userId: string, page: Page) {
    const where = { userId };
    const [rows, total] = await this.db.$transaction([
      this.db.ledgerEntry.findMany({
        where,
        select: {
          id: true,
          kind: true,
          amountTiyin: true,
          refType: true,
          refId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
      this.db.ledgerEntry.count({ where }),
    ]);
    return { rows, total };
  }

  async referrals(userId: string, page: Page) {
    const where = { referredById: userId };
    const [rows, total] = await this.db.$transaction([
      this.db.user.findMany({
        where,
        select: { id: true, username: true, createdAt: true },
        orderBy: [...NEWEST],
        ...page,
      }),
      this.db.user.count({ where }),
    ]);
    return { rows, total };
  }

  async sessions(userId: string, page: Page) {
    const where = { userId };
    const [rows, total] = await this.db.$transaction([
      this.db.webSession.findMany({
        where,
        select: {
          id: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
      this.db.webSession.count({ where }),
    ]);
    return { rows, total };
  }
}
