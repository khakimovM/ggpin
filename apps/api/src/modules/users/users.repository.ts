import { Injectable } from '@nestjs/common';
import type { Locale, Prisma, User } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** The Prisma client inside a `$transaction` callback (also accepts the root client). */
export type Db = Prisma.TransactionClient;

export interface NewUserData {
  readonly telegramId: bigint;
  readonly referralCode: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly photoUrl: string | null;
  readonly locale: Locale;
  readonly lastSeenAt: Date;
}

export interface ProfileUpdate {
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly lastSeenAt: Date;
  /** Only set when the caller supplied one; `undefined` leaves the stored value alone. */
  readonly photoUrl?: string;
}

// All Prisma access of the users module. Methods take an optional `db` so the service can run
// several of them inside one `$transaction` without importing Prisma itself.
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  findById(id: string, db: Db = this.prisma.client): Promise<User | null> {
    return db.user.findUnique({ where: { id } });
  }

  findByTelegramId(telegramId: bigint, db: Db = this.prisma.client): Promise<User | null> {
    return db.user.findUnique({ where: { telegramId } });
  }

  findByReferralCode(referralCode: string, db: Db = this.prisma.client): Promise<User | null> {
    return db.user.findUnique({ where: { referralCode } });
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING RETURNING *. Returns the new row, or null when a row with
   * the same telegramId OR the same referralCode already exists (the caller tells them apart).
   */
  async insertIfAbsent(data: NewUserData, db: Db): Promise<User | null> {
    const rows = await db.user.createManyAndReturn({ data: [data], skipDuplicates: true });
    return rows[0] ?? null;
  }

  /** The row only exists as the FOR UPDATE lock target for purchases; idempotent. */
  async ensureWallet(userId: string, db: Db): Promise<void> {
    await db.wallet.createMany({ data: [{ userId }], skipDuplicates: true });
  }

  updateProfile(id: string, data: ProfileUpdate, db: Db): Promise<User> {
    return db.user.update({ where: { id }, data });
  }

  /** Binds only while the user has no inviter; returns whether this call did it. */
  async bindReferrer(userId: string, inviterId: string, db: Db): Promise<boolean> {
    const { count } = await db.user.updateMany({
      where: { id: userId, referredById: null },
      data: { referredById: inviterId },
    });
    return count === 1;
  }

  updateLocale(id: string, locale: Locale): Promise<User | null> {
    // updateMany + re-read: a user deleted in between is "not found", not a thrown P2025.
    return this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { id }, data: { locale } });
      return count === 0 ? null : tx.user.findUnique({ where: { id } });
    });
  }

  /** Stores the phone only while none is set; returns whether this call stored it. */
  async setPhoneIfAbsent(id: string, phone: string): Promise<boolean> {
    const { count } = await this.prisma.client.user.updateMany({
      where: { id, phone: null },
      data: { phone },
    });
    return count === 1;
  }

  async setBotBlockedAt(telegramId: bigint, at: Date | null): Promise<void> {
    // Idempotent by predicate: re-blocking keeps the first timestamp, clearing a clear is a no-op.
    await this.prisma.client.user.updateMany({
      where:
        at === null
          ? { telegramId, botBlockedAt: { not: null } }
          : { telegramId, botBlockedAt: null },
      data: { botBlockedAt: at },
    });
  }
}
