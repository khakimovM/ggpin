-- D-30.2: ustun nomlari rules/40 qoidasiga moslanadi (unit suffix oxirida emas, valyuta oldida).
-- Prisma rename'ni DROP+ADD qilib chiqaradi; bu yerda qo‘lda to‘g‘rilangan.

-- WalletSnapshot: real RENAME, ma'lumot saqlanadi. WalletSnapshot_balances_check
-- ("nanoTon" >= 0 AND "microUsdt" >= 0) ustun nomi bilan birga avtomatik ko‘chadi.
ALTER TABLE "WalletSnapshot" RENAME COLUMN "tonNano" TO "nanoTon";
ALTER TABLE "WalletSnapshot" RENAME COLUMN "usdtMicro" TO "microUsdt";

-- BonusCode: rewardValue o‘rniga tur bo‘yicha ikkita ustun. Jadval hali bo‘sh bo‘lishi shart;
-- bo‘sh bo‘lmasa ma'lumotni jim yo‘qotmaymiz, migratsiya to‘xtaydi.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BonusCode") THEN
    RAISE EXCEPTION 'BonusCode is not empty: rewardValue cannot be dropped without a data migration (D-30.2)';
  END IF;
END $$;

ALTER TABLE "BonusCode" DROP CONSTRAINT "BonusCode_usage_check";
ALTER TABLE "BonusCode" DROP COLUMN "rewardValue";
ALTER TABLE "BonusCode" ADD COLUMN "rewardTiyin" BIGINT;
ALTER TABLE "BonusCode" ADD COLUMN "rewardCoins" BIGINT;

-- Avvalgi CHECK'dan "rewardValue" > 0 sharti olib tashlandi (u endi BonusCode_reward_check'da).
ALTER TABLE "BonusCode" ADD CONSTRAINT "BonusCode_usage_check" CHECK (
  "maxUses" > 0 AND "usedCount" >= 0 AND "usedCount" <= "maxUses"
);

-- Aynan bitta mukofot ustuni to‘ldiriladi, va u rewardType'ga mos va musbat.
ALTER TABLE "BonusCode" ADD CONSTRAINT "BonusCode_reward_check" CHECK (
  ("rewardType" = 'WALLET_TIYIN' AND "rewardTiyin" > 0 AND "rewardCoins" IS NULL)
  OR ("rewardType" = 'COINS' AND "rewardCoins" > 0 AND "rewardTiyin" IS NULL)
);
