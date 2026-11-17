import { IdempotencyKeySchema, ResourceIdSchema, type AdminConfirmationBody } from '@repo/shared';
import { z } from 'zod';

/**
 * The money and state actions of docs/04, named as `POST /admin/confirmations` names them. The
 * list is checked against the shared union both ways at compile time, so the stored-entry check
 * (`z.enum`) can never drift from it (SA I-1).
 */
export const ADMIN_ACTION_KINDS = [
  'orders.cancel',
  'orders.failAndRefund',
  'orders.refund',
  'payments.reverse',
  'orders.resolve',
  'payments.reviewCredit',
  'users.adjustWallet',
  'cards.resume',
  'fx.set',
  'admins.create',
  'admins.update',
  'admins.sessionsRevoke',
  'sessions.revoke',
] as const satisfies readonly AdminConfirmationBody['action'][];
export type AdminActionKind = (typeof ADMIN_ACTION_KINDS)[number];
type Unlisted = Exclude<AdminConfirmationBody['action'], AdminActionKind>;
const everyKindListed: [Unlisted] extends [never] ? true : never = true;
void everyKindListed;

/** One registry entry as it is kept in sessionStorage: never the reason, never an OTP code. */
export const StoredEntrySchema = z.strictObject({
  adminId: ResourceIdSchema,
  kind: z.enum(ADMIN_ACTION_KINDS),
  targetId: ResourceIdSchema,
  key: IdempotencyKeySchema,
  unknown: z.boolean(),
  conflict: z.boolean(),
  /** Written BEFORE the request leaves (SA M-2): a reload mid-flight reads it as unknown. */
  inFlight: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export type StoredEntry = z.infer<typeof StoredEntrySchema>;

export const PENDING_ACTIONS_STORAGE_KEY = 'ggpin-admin-pending-actions';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The valid stored entries; a broken value or entry is dropped, blocked storage reads empty. */
export function readStoredEntries(): StoredEntry[] {
  try {
    const raw = storage()?.getItem(PENDING_ACTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const entry = StoredEntrySchema.safeParse(item);
      return entry.success ? [entry.data] : [];
    });
  } catch {
    return [];
  }
}

/** Replaces the stored list; a full or blocked storage leaves the memory copy as the only one. */
export function writeStoredEntries(stored: StoredEntry[]): void {
  try {
    const store = storage();
    if (!store) return;
    if (stored.length === 0) store.removeItem(PENDING_ACTIONS_STORAGE_KEY);
    else store.setItem(PENDING_ACTIONS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Memory still protects this page.
  }
}
