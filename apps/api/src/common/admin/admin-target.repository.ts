import type { Db } from '../../infra/prisma/db';

// What an admin may not act on (owner decision 2026-11-18, SA-S6-1 / SA-S6-9): rows matched by
// Telegram id, the one identity a store user and an admin share. Plain functions on the caller's
// transaction (or client), like lockAdminActor.

/** True when the user's Telegram account is the acting admin's own (no money to oneself). */
export async function isAdminsOwnUser(db: Db, adminId: string, userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "User" u JOIN "AdminUser" a ON a."telegramId" = u."telegramId"
    WHERE u."id" = ${userId} AND a."id" = ${adminId}
    LIMIT 1`;
  return rows.length > 0;
}

/** True when the user's Telegram account belongs to any admin row (active or not). */
export async function isAnAdminsUser(db: Db, userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM "User" u JOIN "AdminUser" a ON a."telegramId" = u."telegramId"
    WHERE u."id" = ${userId}
    LIMIT 1`;
  return rows.length > 0;
}
