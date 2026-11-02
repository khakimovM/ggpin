import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

// All Prisma access for web sessions. Slice S6 extends this (create, rotate, revoke, list).
@Injectable()
export class WebSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the session family (the `sid` of an access token) still has a live refresh row for
   * this user. Scoped by userId too, so a token can never vouch for another user's family.
   * `now` is passed in (the injectable clock), never SQL now().
   */
  async isFamilyActive(familyId: string, userId: string, now: Date): Promise<boolean> {
    const row = await this.prisma.client.webSession.findFirst({
      where: { familyId, userId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    return row !== null;
  }
}
