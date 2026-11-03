-- BonusCode_reward_check (20261103164533_d30_column_renames) let "neither column set" through:
-- a CHECK passes when it evaluates to NULL, and ("rewardTiyin" > 0) is NULL for a NULL column,
-- so the whole OR became NULL. Explicit IS NOT NULL makes every branch strictly true/false.
-- A new migration (not an edit) because the previous one is already applied on local databases.
ALTER TABLE "BonusCode" DROP CONSTRAINT "BonusCode_reward_check";

ALTER TABLE "BonusCode" ADD CONSTRAINT "BonusCode_reward_check" CHECK (
  ("rewardType" = 'WALLET_TIYIN' AND "rewardTiyin" IS NOT NULL AND "rewardTiyin" > 0 AND "rewardCoins" IS NULL)
  OR ("rewardType" = 'COINS' AND "rewardCoins" IS NOT NULL AND "rewardCoins" > 0 AND "rewardTiyin" IS NULL)
);
