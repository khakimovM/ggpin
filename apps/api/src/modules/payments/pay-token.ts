import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PAY_TOKEN_PATTERN, ResourceIdSchema } from '@repo/shared';

// The pay-link capability token (D-39, docs/05 §8). 32 random bytes = 256 bits, unpadded
// base64url = 43 characters. Only the HMAC is stored; the plain token exists in exactly one
// response body and is never logged, queued, cached or written to the database.

const TOKEN_BYTES = 32;

// Stand-ins for a malformed id or token: the verifier still computes one HMAC and runs one
// comparison, so a malformed request costs the same as a wrong token (no timing oracle).
const DUMMY_TOKEN = 'A'.repeat(43);
const DUMMY_ID = 'no_such_intent';
/** Never a stored hash (64 hex chars); compared against when the intent has no hash. */
const DUMMY_HASH = '0'.repeat(64);

export function generatePayToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * hex HMAC-SHA256(pepper, intentId + ":" + token). Binding the intent id means a token can only
 * ever open the intent it was issued for, even if two hashes were swapped in the database.
 */
export function hashPayToken(pepper: string, intentId: string, token: string): string {
  return createHmac('sha256', pepper).update(`${intentId}:${token}`).digest('hex');
}

export interface PayTokenCandidate {
  /** The id to look up: the caller's id when well formed, otherwise a dummy that never exists. */
  readonly lookupId: string;
  /** The HMAC to compare; always computed, also for a malformed id or token. */
  readonly hash: string;
  /** False when the id or the token was malformed: the answer is 404 whatever the comparison says. */
  readonly wellFormed: boolean;
}

/** Shapes a request into one HMAC computation, whatever its input looks like. */
export function payTokenCandidate(
  pepper: string,
  intentId: string,
  token: string | undefined,
): PayTokenCandidate {
  const idOk = ResourceIdSchema.safeParse(intentId).success;
  const tokenOk = token !== undefined && PAY_TOKEN_PATTERN.test(token);
  const lookupId = idOk ? intentId : DUMMY_ID;
  return {
    lookupId,
    hash: hashPayToken(pepper, lookupId, tokenOk ? token : DUMMY_TOKEN),
    wellFormed: idOk && tokenOk,
  };
}

/** Constant-time comparison of two hex hashes; a missing stored hash never matches. */
export function payTokenMatches(candidateHash: string, storedHash: string | null): boolean {
  const stored = storedHash ?? DUMMY_HASH;
  const a = Buffer.from(candidateHash, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  // Both are 64 hex chars for every real row; a length mismatch is a corrupt row, not a match.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b) && storedHash !== null;
}
