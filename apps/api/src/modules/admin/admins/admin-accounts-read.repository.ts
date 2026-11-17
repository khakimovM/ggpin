import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** The newest sessions an admin's page lists (each one is a login; 8 h at most). */
export const ADMIN_SESSIONS_SHOWN = 100;

// Read side of admin accounts for the OWNER's «Adminlar» page (docs/04 «Adminlar»). Never the
// session token hash.
@Injectable()
export class AdminAccountsReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** When each admin last signed in: the newest session it opened (a session = one login). */
  async lastLogins(adminIds: readonly string[]): Promise<Map<string, Date>> {
    if (adminIds.length === 0) return new Map();
    const rows = await this.prisma.client.adminSession.groupBy({
      by: ['adminId'],
      where: { adminId: { in: [...adminIds] } },
      _max: { createdAt: true },
    });
    const logins = new Map<string, Date>();
    for (const row of rows)
      if (row._max.createdAt !== null) logins.set(row.adminId, row._max.createdAt);
    return logins;
  }

  async exists(adminId: string): Promise<boolean> {
    return (await this.prisma.client.adminUser.count({ where: { id: adminId } })) > 0;
  }

  sessions(adminId: string) {
    return this.prisma.client.adminSession.findMany({
      where: { adminId },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        ip: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ADMIN_SESSIONS_SHOWN,
    });
  }
}
