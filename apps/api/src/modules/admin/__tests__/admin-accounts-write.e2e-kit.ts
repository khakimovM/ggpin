import { randomUUID } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import type { AdminConfirmationBody } from '@repo/shared';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { adminAuditIdFor } from '../write/admin-write-key';
import { ADMIN_BASE, setCookies, type AdminE2e, type Res } from './admin-e2e.api';
import { adminWriteKit, type Session } from './admin-write.e2e-kit';

// Test kit of the panel's admin management (phase 9 S9a) on top of the S6 write kit: a code for
// every write (D-63 (4)), the PATCH route, and the checks a session's end needs.

const API = '/api/v1/admin';
export const REASON = 'staff change after the review';
export const ME = `${ADMIN_BASE}/me`;

export function adminAccountsKit(t: AdminE2e) {
  const kit = adminWriteKit(t);

  const send = (
    method: 'POST' | 'PATCH',
    who: Session,
    path: string,
    body: object,
    key: string = randomUUID(),
  ): Promise<Res> =>
    t.request(
      method,
      `${API}/${path}`,
      t.spa({ cookie: who.cookie, 'idempotency-key': key }),
      undefined,
      body,
    );

  /** A code for `confirmation`, then the write with it (same key if given). */
  const withCode = async (
    method: 'POST' | 'PATCH',
    who: Session,
    path: string,
    confirmation: AdminConfirmationBody,
    body: object,
    key: string = randomUUID(),
  ): Promise<Res> => {
    const otp = await kit.code(who, confirmation);
    return send(method, who, path, { ...body, reason: REASON, otp }, key);
  };

  const me = async (cookie: string): Promise<number> =>
    (await t.request('GET', ME, t.spa({ cookie }))).statusCode;

  const liveSessionId = async (admin: AdminUser): Promise<string> => {
    const row = await t.db().adminSession.findFirstOrThrow({
      where: { adminId: admin.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row.id;
  };

  /** The panel's new admin rows: removed with the harness's own. */
  const freshTelegramId = (): string => String(nextTestTelegramId());
  const track = async (telegramId: string): Promise<void> => {
    const row = await t.db().adminUser.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (row !== null) t.trackAdmin(row);
  };

  /** The audit row a key would write (whether it was written or not). */
  const auditIdOf = (who: Session, key: string) => adminAuditIdFor(who.admin.id, key);

  const clearedCookie = (res: Res): boolean =>
    setCookies(res).some((c) => c.startsWith(`${t.cookieName}=;`) && /Max-Age=0/i.test(c));

  return {
    ...kit,
    send,
    withCode,
    me,
    liveSessionId,
    freshTelegramId,
    track,
    auditIdOf,
    clearedCookie,
  };
}
