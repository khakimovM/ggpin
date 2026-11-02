-- AlterTable
ALTER TABLE "LoginRequest" ADD COLUMN     "sessionFamilyId" TEXT;

-- CreateIndex
CREATE INDEX "LoginRequest_telegramId_expiresAt_idx" ON "LoginRequest"("telegramId", "expiresAt");
