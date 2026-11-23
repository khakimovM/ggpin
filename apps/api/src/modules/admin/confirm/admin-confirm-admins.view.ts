import { Inject, Injectable } from '@nestjs/common';
import type { AdminConfirmationBody, OtpCheckInput } from '@repo/shared';
import { validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { OWNER_ROW } from '../admins/admin-panel-accounts.service';
import { AdminUsersRepository } from '../admins/admin-users.repository';
import { AdminSessionRepository } from '../auth/admin-session.repository';
import type { AdminOtpSubjectRef } from './admin-otp.issuer';

type AdminsBody = Extract<
  AdminConfirmationBody,
  { action: 'admins.create' | 'admins.update' | 'admins.sessionsRevoke' | 'sessions.revoke' }
>;

const ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  'admins.create',
  'admins.update',
  'admins.sessionsRevoke',
  'sessions.revoke',
]);

/** Only what the message shows: the name and the (masked there) Telegram id. */
const shown = (admin: { readonly name: string; readonly telegramId: bigint }) => ({
  name: admin.name,
  telegramId: admin.telegramId,
});

export function isAdminsConfirmation(body: AdminConfirmationBody): body is AdminsBody {
  return ADMIN_ACTIONS.has(body.action);
}

export interface AdminsServerView {
  readonly otp: OtpCheckInput;
  readonly flags: readonly string[];
  readonly subject: AdminOtpSubjectRef;
}

/**
 * The server's view of an admin-management code (plan S9a, D-63 (4): always a code). No server
 * flag: what the code confirms is the body itself (role, name, activity), shown in words by
 * admin-otp-flags.ts. The message names the target admin with its Telegram id masked. What the
 * action would refuse anyway gets no code (the daily limit is not spent on it): an unknown target
 * `404`, a taken Telegram id `ADMIN_EXISTS`, an OWNER row `OWNER_ROW`. The action checks all of it
 * again under its locks.
 */
@Injectable()
export class AdminConfirmAdminsView {
  constructor(
    private readonly admins: AdminUsersRepository,
    private readonly sessions: AdminSessionRepository,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_CONFIRM_THRESHOLD_TIYIN'>,
  ) {}

  async view(body: AdminsBody): Promise<AdminsServerView> {
    const otp = { thresholdTiyin: this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN };
    switch (body.action) {
      case 'admins.create': {
        const telegramId = BigInt(body.telegramId);
        if ((await this.admins.findByTelegramId(telegramId)) !== null) {
          throw validationError('telegramId', 'ADMIN_EXISTS');
        }
        return { otp, flags: [], subject: { admin: { name: null, telegramId } } };
      }
      case 'admins.update': {
        const target = await this.admins.findById(body.targetId);
        if (target === null) throw new AppError('NOT_FOUND');
        if (target.role === 'OWNER') throw validationError('id', OWNER_ROW);
        return { otp, flags: [], subject: { admin: shown(target) } };
      }
      case 'admins.sessionsRevoke': {
        const target = await this.admins.findById(body.targetId);
        if (target === null) throw new AppError('NOT_FOUND');
        return { otp, flags: [], subject: { admin: shown(target) } };
      }
      case 'sessions.revoke': {
        const session = await this.sessions.findById(body.targetId);
        if (session === null) throw new AppError('NOT_FOUND');
        return { otp, flags: [], subject: { admin: shown(session.admin) } };
      }
    }
  }
}
