-- Phase 4 S7 review, D-52 D1/D4 (additive only): the bank-feed working account and its known
-- authorizations move from Redis to Postgres, so a flushed Redis can no longer reset the baseline
-- silently. BankFeedAccount holds at most one row (slot = 1): the account the session was bound
-- to at the first start; another account's session is refused (account switching is a later
-- slice). BankFeedAuthorization never holds an IP, a country or a region.

-- CreateTable
CREATE TABLE "BankFeedAccount" (
    "id" TEXT NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 1,
    "telegramUserId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankFeedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankFeedAuthorization" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "appName" TEXT,
    "deviceModel" TEXT,
    "authCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankFeedAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankFeedAccount_slot_key" ON "BankFeedAccount"("slot");

-- CreateIndex
CREATE UNIQUE INDEX "BankFeedAuthorization_hash_key" ON "BankFeedAuthorization"("hash");

-- One row at most, a real Telegram user id.
ALTER TABLE "BankFeedAccount"
  ADD CONSTRAINT "BankFeedAccount_slot_check" CHECK ("slot" = 1),
  ADD CONSTRAINT "BankFeedAccount_telegramUserId_check" CHECK ("telegramUserId" > 0);

-- The unsigned decimal of a 64-bit hash; device labels are short display strings only.
ALTER TABLE "BankFeedAuthorization"
  ADD CONSTRAINT "BankFeedAuthorization_hash_check" CHECK ("hash" ~ '^(0|[1-9][0-9]{0,19})$'),
  ADD CONSTRAINT "BankFeedAuthorization_appName_check" CHECK (char_length("appName") <= 128),
  ADD CONSTRAINT "BankFeedAuthorization_deviceModel_check" CHECK (char_length("deviceModel") <= 128);
