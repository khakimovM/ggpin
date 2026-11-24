// What the dev mock "server" has written: replays by key, audit rows, record changes, notes and
// issued codes. Kept in sessionStorage so F5 keeps it (the outcome check after a reload needs the
// audit rows); a Playwright test starts from an empty journal unless it seeds one.
import {
  AdminAuditRowSchema,
  AdminNoteSchema,
  type AdminAuditRow,
  type AdminNote,
} from '@repo/shared';
import { z } from 'zod';

export const MOCK_JOURNAL_KEY = 'ggpin-admin-mock-writes';

const ReplaySchema = z.object({
  hash: z.string(),
  status: z.number().int(),
  data: z.unknown(),
});

const JournalSchema = z.object({
  replays: z.record(z.string(), ReplaySchema).default({}),
  audit: z.array(AdminAuditRowSchema).default([]),
  users: z
    .record(
      z.string(),
      z.object({
        isBlocked: z.boolean().optional(),
        purchaseFrozen: z.boolean().optional(),
        /** Signed tiyin added by adjustments (a string: money, even in the mock). */
        balanceDeltaTiyin: z.string().optional(),
        sessionsEnded: z.boolean().optional(),
      }),
    )
    .default({}),
  notes: z.record(z.string(), z.array(AdminNoteSchema)).default({}),
  cards: z
    .record(
      z.string(),
      z.object({
        status: z.string().optional(),
        autoCreditPaused: z.boolean().optional(),
        receiveLimitTiyin: z.string().optional(),
        monthlyLimitTiyin: z.string().nullable().optional(),
        retiredAt: z.string().nullable().optional(),
      }),
    )
    .default({}),
  payments: z.record(z.string(), z.object({ status: z.string() })).default({}),
  reviews: z.record(z.string(), z.object({ resolution: z.string() })).default({}),
  /**
   * Catalog edits (S8b): field patches by id, the saved product order and packages created in
   * the mock. Loose records here; the catalog views parse every merged record with its shared
   * schema again (catalog-views.ts).
   */
  catalog: z
    .object({
      categories: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      products: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      order: z.array(z.string()).nullable().default(null),
      skus: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      newSkus: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
      routes: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    })
    .prefault({}),
  /**
   * Admin management (S9b): field patches by admin id, admins added in the mock and ended
   * sessions. Loose here; admins-views.ts parses every merged record with its shared schema.
   */
  admins: z
    .object({
      patches: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
      added: z.array(z.record(z.string(), z.unknown())).default([]),
      endedSessions: z.array(z.string()).default([]),
    })
    .prefault({}),
  /**
   * Voided keys (9B-3, docs/04 «Kalitni bekor qilish»): `<adminId>|<key>` → the tombstone's audit
   * id and time. A write with such a key is 409, a void again is VOIDED with the same row.
   */
  voided: z.record(z.string(), z.object({ auditId: z.string(), at: z.string() })).default({}),
  /** Issued codes: challenge id → the canonical confirmation body and who asked. */
  challenges: z
    .record(z.string(), z.object({ canonical: z.string(), adminId: z.string() }))
    .default({}),
});

export type Journal = z.infer<typeof JournalSchema>;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

let memory: Journal = JournalSchema.parse({});

export function readJournal(): Journal {
  const store = storage();
  // In memory only where sessionStorage is unavailable; a cleared key is an empty journal.
  if (store === undefined) return memory;
  const raw = store.getItem(MOCK_JOURNAL_KEY);
  if (raw === null) return JournalSchema.parse({});
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : memory;
  } catch {
    return memory;
  }
}

/** Applies `change` to a copy of the journal and stores it. */
export function updateJournal(change: (journal: Journal) => void): Journal {
  const next = structuredClone(readJournal());
  change(next);
  memory = next;
  storage()?.setItem(MOCK_JOURNAL_KEY, JSON.stringify(next));
  return next;
}

/** A new audit row, newest first (the audit route lists them before the fixtures). */
export function journalAudit(row: AdminAuditRow, journal: Journal): void {
  journal.audit.unshift(row);
}

export function journalNote(userId: string, note: AdminNote, journal: Journal): void {
  journal.notes[userId] = [note, ...(journal.notes[userId] ?? [])].slice(0, 20);
}
