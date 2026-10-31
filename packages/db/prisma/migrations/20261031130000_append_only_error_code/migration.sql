-- The append-only trigger raised SQLSTATE 23001 (restrict_violation). The Prisma pg adapter maps
-- that code to RestrictViolation and drops the trigger's text, so an UPDATE of a ledger row read
-- like a foreign-key problem. A project-specific SQLSTATE falls through to the adapter's generic
-- branch, which keeps both the code and the message: services and logs can tell "someone tried to
-- rewrite history" apart from a real constraint error. Function body only; triggers are unchanged.
CREATE OR REPLACE FUNCTION ggpin_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'GG001', HINT = 'Write a compensating entry instead of changing history.';
END;
$$;
