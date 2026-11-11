-- Migration 9, part 6 (phase 4, third review of S2). Parts 1-5 are applied everywhere, so the
-- remaining gaps close here: two trigger functions replaced (CREATE OR REPLACE, the triggers
-- keep pointing at them) and two new BEFORE UPDATE triggers. No table, column or index changes.
--
-- Checked against the code that writes these tables today: the only write after INSERT is the
-- reversal of a confirmed payment (apps/api wallet repository: status CONFIRMED -> CANCELLED and
-- cancelledAt); review credit writes "reviewId" in the INSERT of the Payment. Neither is touched
-- by the immutability rules below.

-- ============================================================================================
-- Payment: what the payment is, who it is for and where it came from never changes
-- ============================================================================================

-- A payment is a fact: the money of one bank message (or provider transaction) for one user. If
-- "userId", "amountTiyin" or the links could be rewritten after the ledger entry was made, the
-- TOPUP entry (PAYMENT/<id>) would no longer match the row that justifies it. "status",
-- "cancelledAt", "confirmedAt", "raw" and "updatedAt" stay mutable (confirmation flows and the
-- reversal CONFIRMED -> CANCELLED).
CREATE FUNCTION ggpin_payment_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."intentId" IS DISTINCT FROM OLD."intentId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerTxnId" IS DISTINCT FROM OLD."providerTxnId"
     OR NEW."amountTiyin" IS DISTINCT FROM OLD."amountTiyin"
     OR NEW."bankMessageId" IS DISTINCT FROM OLD."bankMessageId"
     OR NEW."reviewId" IS DISTINCT FROM OLD."reviewId" THEN
    RAISE EXCEPTION '% intentId, userId, provider, providerTxnId, amountTiyin, bankMessageId and reviewId are immutable',
      TG_TABLE_NAME
      USING ERRCODE = 'GG001', HINT = 'Only status, cancelledAt, confirmedAt and raw change after INSERT.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_immutable_guard" BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION ggpin_payment_immutable_guard();

-- ============================================================================================
-- PaymentReview: which message and which kind of problem it is never changes
-- ============================================================================================

-- (bankMessageId, kind) is the idempotency key of a review. Moving a review to another message
-- or kind would make the key point at something it never described. Status, resolution, the
-- audit link, card/intent hints and the note are the review's life and stay mutable.
CREATE FUNCTION ggpin_payment_review_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bankMessageId" IS DISTINCT FROM OLD."bankMessageId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION '% bankMessageId and kind are immutable', TG_TABLE_NAME
      USING ERRCODE = 'GG001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentReview_immutable_guard" BEFORE UPDATE ON "PaymentReview"
  FOR EACH ROW EXECUTE FUNCTION ggpin_payment_review_immutable_guard();

-- ============================================================================================
-- Payment consistency: the payment has the provider of its intent; FOUND is read right away
-- ============================================================================================

-- Replaces the function of parts 4-5. New: ANY payment that names an intent has the provider of
-- that intent (a Click payment on a P2P_CARD intent, or the reverse, is a different money
-- channel). The earlier P2P-only provider test is this rule. Also: "intent_found" is taken from
-- FOUND straight after the SELECT ... INTO; before, it relied on INTO writing NULL for no row.
CREATE OR REPLACE FUNCTION ggpin_payment_consistency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent_found BOOLEAN := false;
  intent_user TEXT;
  intent_provider TEXT;
  intent_card TEXT;
  intent_amount BIGINT;
  msg RECORD;
BEGIN
  IF NEW."intentId" IS NOT NULL THEN
    SELECT "userId", "provider"::text, "cardId", "amountTiyin"
      INTO intent_user, intent_provider, intent_card, intent_amount
      FROM "PaymentIntent" WHERE "id" = NEW."intentId";
    intent_found := FOUND;
    IF intent_found AND intent_user <> NEW."userId" THEN
      RAISE EXCEPTION 'Payment user % is not the owner of intent %', NEW."userId", NEW."intentId"
        USING ERRCODE = 'GG004';
    END IF;
    IF intent_found AND intent_provider <> NEW."provider"::text THEN
      RAISE EXCEPTION 'Payment provider % differs from the provider % of intent %',
        NEW."provider", intent_provider, NEW."intentId"
        USING ERRCODE = 'GG004';
    END IF;
  END IF;

  IF NEW."provider" = 'P2P_CARD' AND NEW."bankMessageId" IS NOT NULL THEN
    SELECT "parseStatus"::text AS parse_status, "direction"::text AS direction,
           "amountTiyin" AS amount, "cardId" AS card_id
      INTO msg FROM "BankMessage" WHERE "id" = NEW."bankMessageId";
    IF FOUND THEN
      IF msg.parse_status <> 'PARSED'
         OR msg.direction IS DISTINCT FROM 'CREDIT'
         OR msg.amount IS DISTINCT FROM NEW."amountTiyin" THEN
        RAISE EXCEPTION 'P2P_CARD payment must be a PARSED CREDIT bank message for exactly its amount'
          USING ERRCODE = 'GG004';
      END IF;
      IF intent_found AND (
        intent_card IS DISTINCT FROM msg.card_id
        OR intent_amount IS DISTINCT FROM msg.amount
      ) THEN
        RAISE EXCEPTION 'P2P_CARD payment of intent % must come from a message for the intent card and amount',
          NEW."intentId"
          USING ERRCODE = 'GG004';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================================
-- BankMessage card: ties between RETIRED cards are broken by id
-- ============================================================================================

-- Replaces the function of part 5. "Latest RETIRED" compares (retiredAt, id): two cards retired
-- in the same millisecond used to be both acceptable, so the choice depended on the writer.
CREATE OR REPLACE FUNCTION ggpin_bank_message_card_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card RECORD;
  expected_bank "CardBank";
BEGIN
  IF NEW."cardId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "bank" AS bank, "last4" AS last4, "status" AS status, "retiredAt" AS retired_at
    INTO card FROM "TopupCard" WHERE "id" = NEW."cardId";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing card
  END IF;
  expected_bank := CASE NEW."source"
    WHEN 'HUMO_BOT' THEN 'HUMO'::"CardBank"
    WHEN 'UZCARD_BOT' THEN 'UZCARD'::"CardBank"
  END;
  IF expected_bank IS NULL OR card.bank <> expected_bank THEN
    RAISE EXCEPTION 'BankMessage card % is a % card but the message came from %',
      NEW."cardId", card.bank, NEW."source"
      USING ERRCODE = 'GG003';
  END IF;
  IF NEW."last4" IS NULL OR card.last4 <> NEW."last4" THEN
    RAISE EXCEPTION 'BankMessage card % does not end in the last4 of the message', NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  IF card.status = 'RETIRED' AND EXISTS (
    SELECT 1 FROM "TopupCard" t
    WHERE t."bank" = card.bank AND t."last4" = card.last4 AND t."status" <> 'RETIRED'
  ) THEN
    RAISE EXCEPTION 'BankMessage card % is retired but a live card has the same bank and last4',
      NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  IF card.status = 'RETIRED' AND EXISTS (
    SELECT 1 FROM "TopupCard" t
    WHERE t."bank" = card.bank AND t."last4" = card.last4 AND t."status" = 'RETIRED'
      AND (t."retiredAt", t."id") > (card.retired_at, NEW."cardId")
  ) THEN
    RAISE EXCEPTION 'BankMessage card % is not the most recently retired card with this bank and last4',
      NEW."cardId"
      USING ERRCODE = 'GG003';
  END IF;
  RETURN NEW;
END;
$$;
