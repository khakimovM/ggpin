-- Auth and bot guardrails (phase 2). Additive only: no column/table is dropped, renamed or
-- retyped. Part 1 is the Prisma-generated DDL; part 2 is raw SQL that Prisma cannot express
-- (CHECK constraints). "LoginRequest" had 0 rows in the dev and test databases when this was
-- written, so the new CHECKs validate nothing old.
--
-- No DDL, but a meaning change documented in docs/03 "Migratsiya 4": "LoginRequest"."codeHash"
-- is hex HMAC-SHA256(OTP_PEPPER, nonce || ':' || code) and "WebSession"."refreshHash" is
-- HMAC-SHA256(JWT_REFRESH_SECRET, token). A DB dump alone cannot brute-force a 6-digit code.

-- ============================================================================================
-- Part 1: schema changes (Prisma generated)
-- ============================================================================================

-- AlterTable
-- The user blocked the bot (my_chat_member "kicked" or a 403 from sendMessage). Not the admin
-- block "isBlocked": that one answers USER_BLOCKED, this one only stops notifications.
ALTER TABLE "User" ADD COLUMN     "botBlockedAt" TIMESTAMP(3);

-- CreateIndex
-- For a later sweep that expires stale PENDING/CODE_SENT requests.
CREATE INDEX "LoginRequest_status_expiresAt_idx" ON "LoginRequest"("status", "expiresAt");

-- ============================================================================================
-- Part 2: CHECK constraints on "LoginRequest"
-- ============================================================================================
-- "kind" and "status" stay text (an enum conversion would be a type change); these CHECKs give
-- the same protection and fail closed: a new value must be added to the constraint explicitly.

-- Wrong-code attempts. The upper bound mirrors OTP_MAX_ATTEMPTS = 5 in
-- packages/shared/src/auth/auth-constants.ts: change both together. The service increments
-- attempts atomically with a guard, so this is the last line if that guard ever regresses.
ALTER TABLE "LoginRequest" ADD CONSTRAINT "LoginRequest_attempts_check" CHECK (
  "attempts" BETWEEN 0 AND 5
);

ALTER TABLE "LoginRequest" ADD CONSTRAINT "LoginRequest_kind_check" CHECK (
  "kind" IN ('USER', 'ADMIN')
);

ALTER TABLE "LoginRequest" ADD CONSTRAINT "LoginRequest_status_check" CHECK (
  "status" IN ('PENDING', 'CODE_SENT', 'USED', 'EXPIRED', 'DENIED')
);

-- A request in CODE_SENT must know which account the code went to and what to compare against;
-- otherwise verify could match a code against nothing or bind the session to no one.
ALTER TABLE "LoginRequest" ADD CONSTRAINT "LoginRequest_code_sent_check" CHECK (
  "status" <> 'CODE_SENT' OR ("codeHash" IS NOT NULL AND "telegramId" IS NOT NULL)
);
