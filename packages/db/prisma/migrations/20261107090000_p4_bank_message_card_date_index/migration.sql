-- Phase 4 S6 (D-43): additive index only. The card capacity query (`cardTotals`, @repo/db) sums
-- the PARSED CREDIT messages of each card since its verifiedAt and since the month start; the
-- API runs it on every top-up request and the worker after every credit. The (cardId,
-- tgMessageId) index serves the balance chain, not a tgDate range.

-- CreateIndex
CREATE INDEX "BankMessage_cardId_tgDate_idx" ON "BankMessage"("cardId", "tgDate");
