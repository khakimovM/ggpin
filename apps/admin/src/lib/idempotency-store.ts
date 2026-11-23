import {
  IdempotencyKeySchema,
  ResourceIdSchema,
  type AdminConfirmationBody,
  type AdminPermission,
} from '@repo/shared';
import { z } from 'zod';

/**
 * Every admin write of docs/04 except `confirmations.create` (issuing a code writes nothing),
 * named by its permission key. At compile time the list is a subset of the shared matrix and holds
 * every action a step-up code can confirm; the unit test `idempotency-kinds` proves it equals the
 * matrix's write keys, so the stored-entry check (`z.enum`) never drifts from it (SA I-1).
 */
export const ADMIN_ACTION_KINDS = [
  'orders.note',
  'orders.retry',
  'orders.cancel',
  'orders.failAndRefund',
  'orders.resolve',
  'orders.refund',
  'users.note',
  'users.block',
  'users.unblock',
  'users.freeze',
  'users.unfreeze',
  'users.sessionsRevoke',
  'users.adjustWallet',
  'payments.reviewCredit',
  'payments.reverse',
  'cards.pause',
  'cards.resume',
  'cards.limit',
  'cards.retire',
  'catalog.categoryUpdate',
  'catalog.productUpdate',
  'catalog.productReorder',
  'catalog.skuCreate',
  'catalog.skuUpdate',
  'catalog.routeUpdate',
  'fx.set',
  'admins.create',
  'admins.update',
  'admins.sessionsRevoke',
  'sessions.revoke',
  'queues.retry',
] as const satisfies readonly Exclude<AdminPermission, 'confirmations.create'>[];
export type AdminActionKind = (typeof ADMIN_ACTION_KINDS)[number];
type UnlistedCodeAction = Exclude<AdminConfirmationBody['action'], AdminActionKind>;
const everyCodeActionListed: [UnlistedCodeAction] extends [never] ? true : never = true;
void everyCodeActionListed;

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
  /** When the last attempt left: "start as a new action" waits 60 s from it (Q1, SA L-1). */
  sentAt: z.number().int().nonnegative().optional(),
  /** When the last attempt ended (answer or timeout): the 60 s wait counts from it too (N-1). */
  endedAt: z.number().int().nonnegative().optional(),
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
