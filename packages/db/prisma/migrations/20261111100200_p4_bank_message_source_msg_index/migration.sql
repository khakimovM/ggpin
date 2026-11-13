-- Phase 4 follow-up N3 (planned for "the next schema change", which is phase 5): the stored-message
-- lookup reads BankMessage by (source, tgMessageId), and the table's unique index leads with
-- senderId, so it cannot serve that lookup. Index only; no data or column changes.

-- CreateIndex
CREATE INDEX "BankMessage_source_tgMessageId_idx" ON "BankMessage"("source", "tgMessageId");
