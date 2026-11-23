import { Inject, Injectable } from '@nestjs/common';
import type { AdminUser, Prisma } from '@repo/db';
import type {
  AdminAccount,
  AdminAccountResponse,
  AdminCreateBody,
  AdminSessionsRevokeResponse,
  AdminUpdateBody,
} from '@repo/shared';
import { checkedId, checkedReason, validationError } from '../../../common/admin/admin-input';
import { checkedAuditActor, type AdminActor } from '../../../common/admin/audit-actor';
import { confirmActorInTx, type ActorAfter } from '../../../common/admin/audit-actor.check';
import { verifyAdminStepUp } from '../../../common/admin/step-up';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import type { Db } from '../../../infra/prisma/db';
import { isUniqueViolation } from '../../payments/db-errors';
import { ReviewEffects } from '../../payments/review-effects';
import { AdminLoginRequestRepository } from '../auth/admin-login-request.repository';
import { AdminSessionRepository } from '../auth/admin-session.repository';
import { adminAccountOf } from './admin-account.mapper';
import { isAllowlisted } from './admin-allowlist';
import {
  AdminUsersRepository,
  type AdminAuditData,
  type PanelAdminChange,
} from './admin-users.repository';

const TELEGRAM_ID_INDEX = 'AdminUser_telegramId_key';

/** `400 fields[{ path: "id", code: "OWNER_ROW" }]`: an OWNER row is the CLI's (Q7 a). */
export const OWNER_ROW = 'OWNER_ROW';

type Allowlist = Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>;

type AuditFacts = Omit<AdminAuditData, 'id' | 'actorType' | 'actorId' | 'ip' | 'reason' | 'after'>;

/**
 * The panel's admin management (docs/04 «Adminlar», plan S9a, D-63 (4)/(6), Q7, Q8), OWNER only.
 * The owner CLI's services (AdminAccountsService, AdminLifecycleService) stay as they are: the
 * panel never touches an OWNER row (create, role and activity of an OWNER are CLI only), so it
 * never needs their last-OWNER rule or its lock on every OWNER row.
 *
 * Every write: the code checked BEFORE the transaction (always required, D-63 (4)); then ONE
 * transaction in the lock order acting admin FOR SHARE (confirmActorInTx) -> target AdminUser ->
 * session rows; the AuditLog row's id is the request's Idempotency-Key row. A change that changes
 * nothing writes nothing (`auditId: null`). The owners' `adminAction` alert follows the commit
 * (a rolled-back write tells nobody anything). One step comes before the code: `update` refuses an
 * OWNER target (self included) with `OWNER_ROW` on an unlocked read (SA S9a-I2), so two OWNERs
 * patching each other never upgrade FOR SHARE to FOR UPDATE into 40P01; the locked check stays.
 */
@Injectable()
export class AdminPanelAccountsService {
  constructor(
    private readonly admins: AdminUsersRepository,
    private readonly sessions: AdminSessionRepository,
    private readonly codes: AdminLoginRequestRepository,
    @Inject(ReviewEffects) private readonly alerts: Pick<ReviewEffects, 'adminAction'>,
    @Inject(APP_CONFIG) private readonly config: Allowlist,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A new OPERATOR or SUPPORT (an OWNER only through `admin:add`). */
  async create(actor: AdminActor, body: AdminCreateBody): Promise<AdminAccountResponse> {
    const telegramId = BigInt(body.telegramId);
    const allowlisted = isAllowlisted(this.config, telegramId);
    try {
      return await this.write(actor, body.reason, async (tx, audit) => {
        // An existing row (active or not) is never overwritten, as in the CLI.
        if ((await this.admins.findByTelegramId(telegramId, tx)) !== null) {
          throw validationError('telegramId', 'ADMIN_EXISTS');
        }
        const admin = await this.admins.create(tx, {
          telegramId,
          name: body.name,
          role: body.role,
        });
        await audit(
          { action: 'ADMIN_CREATE', targetType: 'AdminUser', targetId: admin.id, before: null },
          { telegramId: body.telegramId, name: body.name, role: body.role, isActive: true },
          { allowlisted },
        );
        return { admin: await this.account(tx, admin.id), ...this.applied(actor) };
      });
    } catch (error) {
      // A parallel add of the same id (another key) won the unique index after our read.
      if (isUniqueViolation(error, TELEGRAM_ID_INDEX)) {
        throw validationError('telegramId', 'ADMIN_EXISTS');
      }
      throw error;
    }
  }

  /**
   * Rename, OPERATOR <-> SUPPORT, deactivate or reactivate a non-OWNER admin. A role change and
   * any change of activity end every session of the admin in the same transaction (a new role or
   * a comeback means a new login); a deactivation also expires the open admin login codes of its
   * Telegram id, so a code sent before it never opens a session.
   */
  async update(
    actor: AdminActor,
    rawId: string,
    body: AdminUpdateBody,
  ): Promise<AdminAccountResponse> {
    const id = checkedId('id', rawId);
    const now = this.clock.now();
    // SA S9a-I2: an OWNER row is refused BEFORE any lock. Under the locks the acting OWNER holds
    // its own row FOR SHARE and then wants the target FOR UPDATE: two OWNERs patching each other
    // (or one patching itself twice) would upgrade crosswise, a 40P01. The check under the lock
    // below stays: it catches a CLI promotion that lands between this read and the lock.
    if ((await this.admins.findById(id))?.role === 'OWNER') throw validationError('id', OWNER_ROW);
    return this.write(actor, body.reason, async (tx, audit) => {
      const target = await this.admins.lockById(tx, id, 'UPDATE');
      if (target === null) throw new AppError('NOT_FOUND');
      if (target.role === 'OWNER') throw validationError('id', OWNER_ROW);
      const change = changeOf(target, body);
      if (Object.keys(change).length === 0) {
        return { admin: await this.account(tx, id), auditId: null, applied: false };
      }
      if (!(await this.admins.updateNonOwner(tx, id, change))) throw new AppError('NOT_FOUND');
      const endsSessions = change.role !== undefined || change.isActive !== undefined;
      const revokedSessions = endsSessions ? await this.endAllSessions(tx, id, now) : 0;
      const expired =
        change.isActive === false
          ? { expiredLoginCodes: await this.codes.expireOpenOf(target.telegramId, tx) }
          : {};
      const comeback =
        change.isActive === true
          ? { allowlisted: isAllowlisted(this.config, target.telegramId) }
          : {};
      await audit(
        {
          action: 'ADMIN_UPDATE',
          targetType: 'AdminUser',
          targetId: id,
          before: previousOf(target, change),
        },
        { ...change },
        { ...(endsSessions ? { revokedSessions } : {}), ...expired, ...comeback },
      );
      return { admin: await this.account(tx, id), ...this.applied(actor) };
    });
  }

  /**
   * Ends every session of one admin, an OWNER's too (Q7 b: a stolen session is cut from the panel,
   * with the code and the alert). Always one audit row, like the users' session revoke.
   */
  revokeAdminSessions(actor: AdminActor, rawId: string, reason: string) {
    const id = checkedId('id', rawId);
    const now = this.clock.now();
    return this.write(actor, reason, async (tx, audit): Promise<AdminSessionsRevokeResponse> => {
      const target = await this.admins.lockById(tx, id, 'SHARE');
      if (target === null) throw new AppError('NOT_FOUND');
      const revokedSessions = await this.endAllSessions(tx, id, now);
      // confirmActorInTx found the acting session open: revoking one's own admin ends it.
      const currentRevoked = id === actor.adminId;
      const counts = { revokedSessions, currentRevoked };
      await audit(
        { action: 'ADMIN_SESSIONS_REVOKE', targetType: 'AdminUser', targetId: id, before: null },
        counts,
      );
      return { ...counts, ...this.applied(actor) };
    });
  }

  /** Ends one session (of any admin, an OWNER's too); always one audit row. */
  revokeSession(actor: AdminActor, rawSessionId: string, reason: string) {
    const sessionId = checkedId('id', rawSessionId);
    const now = this.clock.now();
    return this.write(actor, reason, async (tx, audit): Promise<AdminSessionsRevokeResponse> => {
      const session = await this.sessions.findById(sessionId, tx);
      if (session === null) throw new AppError('NOT_FOUND');
      if ((await this.admins.lockById(tx, session.adminId, 'SHARE')) === null) {
        throw new AppError('NOT_FOUND');
      }
      await this.sessions.lockAdminSessions(tx, session.adminId);
      const revoked = await this.sessions.revokeOne(tx, sessionId, session.adminId, now);
      const counts = {
        revokedSessions: revoked ? 1 : 0,
        currentRevoked: revoked && sessionId === actor.sessionId,
      };
      await audit(
        {
          action: 'ADMIN_SESSION_REVOKE',
          targetType: 'AdminSession',
          targetId: sessionId,
          before: null,
        },
        { adminId: session.adminId, ...counts },
      );
      return { ...counts, ...this.applied(actor) };
    });
  }

  /**
   * The code first (outside the transaction: its attempt is counted even when the action is then
   * refused), then ONE transaction that re-reads the acting admin first. `audit` writes the one
   * row; only a committed row raises the alert.
   */
  private async write<R>(
    actor: AdminActor,
    reason: string,
    work: (tx: Db, audit: AuditWriter) => Promise<R>,
  ): Promise<R> {
    const checked = checkedAuditActor(actor);
    const why = checkedReason(reason);
    if (!(await verifyAdminStepUp(checked))) throw validationError('otp', 'OTP_REQUIRED');
    const now = this.clock.now();
    const done = await this.admins.transaction(async (tx) => {
      const raised = { alert: false };
      const who: ActorAfter = await confirmActorInTx(tx, checked, now);
      const audit: AuditWriter = async (facts, after, extra = {}) => {
        raised.alert = true;
        await this.admins.createAudit(tx, {
          ...facts,
          id: actor.request.auditId,
          actorType: 'ADMIN',
          actorId: actor.adminId,
          // The code was verified above (D-46, docs/04 «Tasdiq kodi»): every row says so.
          after: { ...after, ...extra, otpVerified: true, ...who },
          reason: why,
          ip: actor.ip,
        });
      };
      return { result: await work(tx, audit), alert: raised.alert };
    });
    if (done.alert) await this.alerts.adminAction(actor.request.auditId);
    return done.result;
  }

  /**
   * Every session of the admin ended, under the sessions' advisory lock taken LAST (after the
   * target row): a login that is committing a session finishes first and its session ends too.
   */
  private async endAllSessions(tx: Db, adminId: string, now: Date): Promise<number> {
    await this.sessions.lockAdminSessions(tx, adminId);
    return this.sessions.revokeAllOf(tx, adminId, now);
  }

  private async account(tx: Db, id: string): Promise<AdminAccount> {
    const row = await this.admins.account(id, this.clock.now(), tx);
    if (row === null) throw new AppError('INTERNAL_ERROR');
    return adminAccountOf(row, this.config);
  }

  private applied(actor: AdminActor): { auditId: string; applied: true } {
    return { auditId: actor.request.auditId, applied: true };
  }
}

type AuditWriter = (
  facts: AuditFacts,
  after: Prisma.InputJsonObject,
  extra?: Prisma.InputJsonObject,
) => Promise<void>;

/** The fields the body asks to change and that differ from the locked row. */
function changeOf(target: AdminUser, body: AdminUpdateBody): PanelAdminChange {
  return {
    ...(body.name !== undefined && body.name !== target.name ? { name: body.name } : {}),
    ...(body.role !== undefined && body.role !== target.role ? { role: body.role } : {}),
    ...(body.isActive !== undefined && body.isActive !== target.isActive
      ? { isActive: body.isActive }
      : {}),
  };
}

/** The old values of exactly the changed fields (audit `before`). */
function previousOf(target: AdminUser, change: PanelAdminChange): Prisma.InputJsonObject {
  return {
    ...(change.name === undefined ? {} : { name: target.name }),
    ...(change.role === undefined ? {} : { role: target.role }),
    ...(change.isActive === undefined ? {} : { isActive: target.isActive }),
  };
}
