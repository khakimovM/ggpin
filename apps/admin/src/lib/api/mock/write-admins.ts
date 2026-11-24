// Admin management of the dev mock (docs/04 «Adminlar (OWNER)», S9a): add, change, sessions.
// Like the API: OWNER only, the code always and bound to the body, OPERATOR/SUPPORT only, an
// OWNER row refused with OWNER_ROW (Q7 a) but its sessions may be ended (Q7 b), a taken Telegram
// id is ADMIN_EXISTS, a role change or a deactivation ends the admin's sessions, a PATCH that
// changes nothing writes nothing, and ending this tab's own session signs the mock out.
import {
  AdminAccountResponseSchema,
  AdminCreateBodySchema,
  AdminManagementBodySchema,
  AdminSessionsRevokeResponseSchema,
  AdminUpdateBodySchema,
  type AdminSessionListResponse,
} from '@repo/shared';
import { MOCK_ALLOWLIST, adminView, adminsView, endSessionsOf, findSession } from './admins-views';
import { mid } from './data-common';
import { writeMockState } from './mock-state';
import { fail, ok, type MockReply, type MockRoute } from './router';
import { checkCode, fieldError, writeRoute, type WriteContext } from './write-kit';

const patch = (route: MockRoute): MockRoute => ({ ...route, method: 'PATCH' });

/** The answer of both session routes; this tab's own session among them signs the mock out. */
function revoked(
  context: WriteContext<{ reason: string }>,
  ended: AdminSessionListResponse,
  row: { action: string; targetType: string; targetId: string },
): MockReply {
  context.audit({ ...row, reason: context.body.reason });
  const currentRevoked = ended.some((session) => session.current);
  if (currentRevoked) writeMockState({ signedIn: false });
  return ok({
    revokedSessions: ended.length,
    currentRevoked,
    auditId: context.auditId,
    applied: true,
  });
}

export const adminWriteRoutes: readonly MockRoute[] = [
  writeRoute({
    pattern: '/admin/admins',
    permission: 'admins.create',
    body: AdminCreateBodySchema,
    response: AdminAccountResponseSchema,
    run: (context) => {
      const { telegramId, name, role, reason } = context.body;
      const refused = checkCode(context, {
        required: true,
        confirmation: { action: 'admins.create', telegramId, name, role },
      });
      if (refused !== null) return refused;
      if (adminsView(context.journal).some((admin) => admin.telegramId === telegramId)) {
        return fieldError('telegramId', 'ADMIN_EXISTS');
      }
      const admin = {
        id: mid('adm', 100 + context.journal.admins.added.length),
        telegramId,
        name,
        role,
        isActive: true,
        allowlisted: MOCK_ALLOWLIST.includes(telegramId),
        lastLoginAt: null,
        activeSessions: 0,
        createdAt: context.now.toISOString(),
      };
      context.journal.admins.added.push(admin);
      context.audit({
        action: 'ADMIN_CREATE',
        targetType: 'AdminUser',
        targetId: admin.id,
        reason,
      });
      return ok({ admin, auditId: context.auditId, applied: true });
    },
  }),
  patch(
    writeRoute({
      pattern: '/admin/admins/:id',
      permission: 'admins.update',
      body: AdminUpdateBodySchema,
      response: AdminAccountResponseSchema,
      run: (context) => {
        const id = context.params.id ?? '';
        const current = adminView(id, context.journal);
        if (current === undefined) return fail('NOT_FOUND');
        if (current.role === 'OWNER') return fieldError('id', 'OWNER_ROW');
        const { name, role, isActive, reason } = context.body;
        const refused = checkCode(context, {
          required: true,
          confirmation: { action: 'admins.update', targetId: id, name, role, isActive },
        });
        if (refused !== null) return refused;
        const changed = Object.fromEntries(
          Object.entries({ name, role, isActive }).filter(
            ([key, value]) => value !== undefined && current[key as keyof typeof current] !== value,
          ),
        );
        if (Object.keys(changed).length === 0) {
          return ok({ admin: current, auditId: null, applied: false });
        }
        context.journal.admins.patches[id] = { ...context.journal.admins.patches[id], ...changed };
        if ('role' in changed || changed.isActive === false) endSessionsOf(id, context.journal);
        context.audit({ action: 'ADMIN_UPDATE', targetType: 'AdminUser', targetId: id, reason });
        return ok({
          admin: adminView(id, context.journal),
          auditId: context.auditId,
          applied: true,
        });
      },
    }),
  ),
  writeRoute({
    pattern: '/admin/admins/:id/sessions/revoke',
    permission: 'admins.sessionsRevoke',
    body: AdminManagementBodySchema,
    response: AdminSessionsRevokeResponseSchema,
    run: (context) => {
      const id = context.params.id ?? '';
      if (adminView(id, context.journal) === undefined) return fail('NOT_FOUND');
      const refused = checkCode(context, {
        required: true,
        confirmation: { action: 'admins.sessionsRevoke', targetId: id },
      });
      if (refused !== null) return refused;
      return revoked(context, endSessionsOf(id, context.journal), {
        action: 'ADMIN_SESSIONS_REVOKE',
        targetType: 'AdminUser',
        targetId: id,
      });
    },
  }),
  writeRoute({
    pattern: '/admin/sessions/:id/revoke',
    permission: 'sessions.revoke',
    body: AdminManagementBodySchema,
    response: AdminSessionsRevokeResponseSchema,
    run: (context) => {
      const id = context.params.id ?? '';
      const found = findSession(id, context.journal);
      if (found === undefined) return fail('NOT_FOUND');
      const refused = checkCode(context, {
        required: true,
        confirmation: { action: 'sessions.revoke', targetId: id },
      });
      if (refused !== null) return refused;
      const open = found.session.revokedAt === null;
      if (open) context.journal.admins.endedSessions.push(id);
      return revoked(context, open ? [found.session] : [], {
        action: 'ADMIN_SESSION_REVOKE',
        targetType: 'AdminSession',
        targetId: id,
      });
    },
  }),
];
