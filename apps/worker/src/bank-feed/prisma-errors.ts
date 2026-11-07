// Prisma error codes the matcher treats as "another processor already wrote this": a unique
// violation (P2002) of an outcome, a payment or a ledger key. Read structurally so no Prisma
// runtime class has to be imported here. The PG exclusion violation (23P01) is NOT included:
// it would mean two reservations overlap, which is a bug to surface, not a replay.
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === 'P2002';
}
