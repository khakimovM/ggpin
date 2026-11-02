-- Follow-up to 20261102171806_login_session_link (same change, split in two because that
-- migration was already applied to the dev database before this CHECK was appended; an applied
-- migration is never edited). Additive: one CHECK, nothing dropped or retyped. "LoginRequest"
-- has no rows with a non-NULL "sessionFamilyId" yet (the column is new), so it validates nothing old.

-- The web session a verified code opened is only recorded on a request that was actually used
-- (USED), or later denied after use (DENIED, the "this was not me" button pressed once the
-- code had already been exchanged). Any other state with a family id is a bug.
ALTER TABLE "LoginRequest" ADD CONSTRAINT "LoginRequest_session_family_check" CHECK (
  "sessionFamilyId" IS NULL OR "status" IN ('USED', 'DENIED')
);
