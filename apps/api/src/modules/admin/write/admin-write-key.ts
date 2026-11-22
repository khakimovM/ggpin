import type { AdminPermission } from '@repo/shared';
import { createHash } from 'node:crypto';

// The idempotency of an admin write (docs/04 «Admin» — `Idempotency-Key`): the key is bound per
// (adminId, key) to the action's AuditLog row. The row's id is derived from the pair, so a second
// request with the same key can only ever find or collide with that one row (the primary key is
// the guard, no new table or column).

/** `a` + 31 hex of sha256(adminId|key): a valid ResourceId no CLI id or cuid can equal. */
export function adminAuditIdFor(adminId: string, key: string): string {
  return `a${createHash('sha256').update(`${adminId}|${key}`).digest('hex').slice(0, 31)}`;
}

/** The step-up answer is not part of what the request asks for (S3 micro reviews). */
const NOT_HASHED = new Set(['otp', 'challengeId']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined && !NOT_HASHED.has(key))
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/**
 * sha256 of what the request asks for: the route's permission, its target and the parsed body
 * WITHOUT `otp` (and its `challengeId`). The same key and body with another code is the same
 * request (a replay, `applied: false`); any other field is a different one (409). Stored in
 * `AuditLog.after.requestHash` (never shown: a secret-class audit key).
 */
export function adminRequestHash(
  permission: AdminPermission,
  targetId: string,
  body: object,
): string {
  const text = JSON.stringify([permission, targetId, canonical(body)]);
  return createHash('sha256').update(text).digest('hex');
}
