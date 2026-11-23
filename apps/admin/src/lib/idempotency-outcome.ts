// "Did my action run?" after an unknown outcome (Q1 = A, SA L-1, docs/04 «Idempotency-Key»). The
// audit row of an admin write has an id derived from the key, so the panel can look for exactly
// that row instead of guessing from recent ones. Nothing secret is involved: the key is ours.

/**
 * How long after the last attempt left or ended "start as a new action" stays closed. The server
 * has no request deadline of its own yet (SA-1, phase 9-B). What a write can spend there: waits for
 * a pg pool connection before its transaction (up to 5 s each, CONNECTION_TIMEOUT_MS), Redis calls
 * (rate limits, step-up code; ~5-10 s in the worst case), then the transaction itself (card and
 * review-credit writes: 4 s maxWait + 15 s, card-lock-timing.ts; user and wallet writes: Prisma's
 * 2 s + 5 s). The client gives up after WRITE_TIMEOUT_MS (30 s), which alone does not cover that;
 * the margin is the sum: 30 s + these 60 s after the end, ~90 s from the send. The hard guarantee
 * is the server-side voiding of the old key (SA-1, 9-B).
 */
export const OUTCOME_WAIT_MS = 60_000;

/**
 * The search has no `from` (SA L-1): actor + target are enough, so the client's wall clock plays no
 * part. More rows than MAX_PAGES pages read is "unproven" (a failed check), never "not found".
 */
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The audit row id the API gives the write sent with `key` by `adminId`:
 * `a` + the first 31 hex characters of sha256(`<adminId>|<key>`) (`adminAuditIdFor` on the API;
 * the golden vector is shared by both test suites). SubtleCrypto needs a secure context (the
 * panel is https, dev is localhost); without it this rejects and the check reports a failure.
 */
export async function expectedAuditId(adminId: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${adminId}|${key}`),
  );
  return `a${hex(digest).slice(0, 31)}`;
}

/** Whether the wait is over: `elapsedMs` is since the last attempt left or ended (pendingElapsedMs). */
export function startNewAllowed(elapsedMs: number): boolean {
  return elapsedMs >= OUTCOME_WAIT_MS;
}

export type OutcomeVerdict = 'found' | 'notFound';

/** One page of the audit log, as `GET /admin/audit-log` returns it (ids only are needed). */
export type AuditPageFetch = (query: {
  actorId: string;
  targetId: string;
  page: number;
  limit: number;
}) => Promise<{ items: readonly { id: string }[]; meta: { total: number } }>;

/**
 * Looks for the row in the audit log, filtered by actor and target. Only a complete search says
 * `notFound`: the DISTINCT rows read must reach the latest `total` (S7b CR M-1). A list longer than
 * the pages read, a short or empty page before the total, a row added during the search (rows
 * shift down, one repeats, the total grows: it may be the very row looked for) and any failed
 * request all throw (unproven), so a new key is never offered on a guess.
 */
export async function findActionAudit(
  input: { adminId: string; targetId: string; auditId: string },
  fetchPage: AuditPageFetch,
): Promise<OutcomeVerdict> {
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, meta } = await fetchPage({
      actorId: input.adminId,
      targetId: input.targetId,
      page,
      limit: PAGE_LIMIT,
    });
    if (items.some((row) => row.id === input.auditId)) return 'found';
    for (const row of items) seen.add(row.id);
    if (seen.size >= meta.total) return 'notFound';
    if (items.length < PAGE_LIMIT) break;
  }
  throw new Error('audit search incomplete');
}
