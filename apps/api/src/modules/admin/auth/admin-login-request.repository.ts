import { Injectable } from '@nestjs/common';
import type { Db } from '../../../infra/prisma/db';
import { LoginRequestRepository, type LoginRequestKind } from '../../auth/login-request.repository';

/**
 * The web login's repository, scoped to `LoginRequest.kind = 'ADMIN'`: every claim, deny,
 * attempt, release and code count of the admin panel sees admin rows only, and the web login
 * never sees them.
 */
@Injectable()
export class AdminLoginRequestRepository extends LoginRequestRepository {
  protected override readonly kind: LoginRequestKind = 'ADMIN';

  /**
   * Every open admin login request of this Telegram id (PENDING or CODE_SENT) -> EXPIRED, inside
   * the deactivation's transaction, so a code sent before it can never be used. Admin rows only:
   * the same person's web-store login requests are not touched. Returns how many expired.
   */
  async expireOpenOf(telegramId: bigint, db: Db): Promise<number> {
    const { count } = await db.loginRequest.updateMany({
      where: { kind: this.kind, telegramId, status: { in: ['PENDING', 'CODE_SENT'] } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }
}
