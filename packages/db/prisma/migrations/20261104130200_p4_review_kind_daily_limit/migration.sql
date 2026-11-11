-- One review kind covers both daily caps (the 7-day-old-account limit and the all-accounts limit);
-- the review's note says which one was exceeded. The value was named NEW_ACCOUNT_LIMIT in
-- 20261104130000_p4_wallet_p2p, which is already applied, so it is renamed here instead of edited.
-- No row can use it yet: nothing writes reviews before phase 4 slice S6.
ALTER TYPE "PaymentReviewKind" RENAME VALUE 'NEW_ACCOUNT_LIMIT' TO 'DAILY_LIMIT';
