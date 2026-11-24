// The admins and their sessions as the dev mock "server" sees them now: the fixtures, plus the
// admins added and the changes and ended sessions written by the S9b mock routes (journal). Every
// merged record is parsed with its shared schema again, like catalog-views.ts.
import {
  AdminAccountListResponseSchema,
  AdminAccountSchema,
  AdminSessionListResponseSchema,
  type AdminAccount,
  type AdminSessionListResponse,
} from '@repo/shared';
import { ADMINS, adminSessionsFixture } from './fixtures-ops';
import { readJournal, type Journal } from './mock-journal';

/**
 * `ADMIN_TELEGRAM_IDS` of the mock: the fixtures' allowlisted admins and one spare id, so an add
 * shows both answers (5550000001 can sign in at once; any other new id gets `allowlisted: false`).
 */
export const MOCK_ALLOWLIST: readonly string[] = [
  ...ADMINS.filter((admin) => admin.allowlisted).map((admin) => admin.telegramId),
  '5550000001',
];

function sessionsOf(adminId: string, journal: Journal, now: string): AdminSessionListResponse {
  const ended = new Set(journal.admins.endedSessions);
  return AdminSessionListResponseSchema.parse(
    adminSessionsFixture(adminId).map((session) =>
      ended.has(session.id) && session.revokedAt === null
        ? { ...session, revokedAt: now }
        : session,
    ),
  );
}

/** The sessions of one admin, the ended ones marked revoked (as the API lists them). */
export function adminSessionsView(adminId: string, journal: Journal = readJournal()) {
  return sessionsOf(adminId, journal, new Date().toISOString());
}

/** Every admin, with the journal's changes and a live session count. */
export function adminsView(journal: Journal = readJournal()): AdminAccount[] {
  const now = new Date().toISOString();
  const added = journal.admins.added.map((row) => AdminAccountSchema.parse(row));
  return AdminAccountListResponseSchema.parse(
    [...ADMINS, ...added].map((admin) => ({
      ...admin,
      ...journal.admins.patches[admin.id],
      activeSessions: sessionsOf(admin.id, journal, now).filter((s) => s.revokedAt === null).length,
    })),
  );
}

export function adminView(adminId: string, journal: Journal): AdminAccount | undefined {
  return adminsView(journal).find((admin) => admin.id === adminId);
}

/** Ends every open session of `adminId` in the draft; the sessions it ended. */
export function endSessionsOf(adminId: string, journal: Journal): AdminSessionListResponse {
  const open = adminSessionsView(adminId, journal).filter((session) => session.revokedAt === null);
  journal.admins.endedSessions.push(...open.map((session) => session.id));
  return open;
}

/** The session with `sessionId` and whose it is, among every admin's sessions. */
export function findSession(sessionId: string, journal: Journal) {
  for (const admin of adminsView(journal)) {
    const session = adminSessionsView(admin.id, journal).find((one) => one.id === sessionId);
    if (session !== undefined) return { admin, session };
  }
  return undefined;
}
