import { Inject, Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../bank-feed/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { KeepaliveFailure } from './fragment-probe';

// FragmentSession state for the keep-alive and the health check (phase 5 S7). Every move is a
// compare-and-set on the row's status (and on lastError / deadAt), so two looks at once (two
// replicas, a slow tick) make one transition: one death, one alert. No cookie column is read here
// except to hand the blob to the probe.

export interface SessionRow {
  readonly id: string;
  readonly status: 'ACTIVE' | 'DEAD';
  readonly cookiesEnc: string;
  readonly lastOkAt: Date | null;
  readonly deadAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

const SELECT = {
  id: true,
  status: true,
  cookiesEnc: true,
  lastOkAt: true,
  deadAt: true,
  lastError: true,
  createdAt: true,
} as const;

type PrismaHolder = Pick<PrismaService, 'client'>;

function rowOf(row: Omit<SessionRow, 'status'> & { readonly status: string }): SessionRow {
  // The CHECK constraint allows these two only (FragmentSession_status_check).
  return { ...row, status: row.status === 'ACTIVE' ? 'ACTIVE' : 'DEAD' };
}

@Injectable()
export class FragmentSessionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  async active(): Promise<SessionRow | null> {
    const row = await this.prisma.client.fragmentSession.findFirst({
      where: { status: 'ACTIVE' },
      select: SELECT,
    });
    return row === null ? null : rowOf(row);
  }

  /** The most recent session the keep-alive declared DEAD (replaced rows have no deadAt). */
  async latestDeath(): Promise<SessionRow | null> {
    const row = await this.prisma.client.fragmentSession.findFirst({
      where: { status: 'DEAD', deadAt: { not: null } },
      orderBy: [{ deadAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
    });
    return row === null ? null : rowOf(row);
  }

  /**
   * The session this one took over from: the newest older row that was ever used (logged in once
   * or declared DEAD). Rows imported and replaced before their first OK are skipped, so an import
   * that failed at once does not hide the death it was meant to end.
   */
  async predecessor(session: Pick<SessionRow, 'id' | 'createdAt'>): Promise<SessionRow | null> {
    const row = await this.prisma.client.fragmentSession.findFirst({
      where: {
        id: { not: session.id },
        createdAt: { lte: session.createdAt },
        OR: [{ lastOkAt: { not: null } }, { deadAt: { not: null } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: SELECT,
    });
    return row === null ? null : rowOf(row);
  }

  /** ACTIVE: a live session. DEAD: none is live and the newest one died. NONE: there never was. */
  async state(): Promise<'ACTIVE' | 'DEAD' | 'NONE'> {
    if ((await this.active()) !== null) return 'ACTIVE';
    return (await this.latestDeath()) === null ? 'NONE' : 'DEAD';
  }

  async markOk(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.client.fragmentSession.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { lastOkAt: now, lastError: null },
    });
    return count === 1;
  }

  /** The first failure in a row: remembered in lastError (the second one kills, see markDead). */
  async markFirstFailure(id: string, code: KeepaliveFailure): Promise<boolean> {
    const { count } = await this.prisma.client.fragmentSession.updateMany({
      where: { id, status: 'ACTIVE', lastError: null },
      data: { lastError: code },
    });
    return count === 1;
  }

  /** The second failure in a row: DEAD with deadAt. Null when another look moved it first. */
  async markDead(id: string, code: KeepaliveFailure, now: Date): Promise<SessionRow | null> {
    const { count } = await this.prisma.client.fragmentSession.updateMany({
      where: { id, status: 'ACTIVE', lastError: { not: null } },
      data: { status: 'DEAD', deadAt: now, lastError: code },
    });
    if (count !== 1) return null;
    const row = await this.prisma.client.fragmentSession.findUnique({
      where: { id },
      select: SELECT,
    });
    return row === null ? null : rowOf(row);
  }

  /**
   * A DEAD session whose page is logged in again (a network outage, not a logout): ACTIVE again,
   * for the same death only (deadAt), and only while no other session is ACTIVE (the partial
   * unique key refuses a second one: false).
   */
  async revive(id: string, deadAt: Date, now: Date): Promise<boolean> {
    try {
      const { count } = await this.prisma.client.fragmentSession.updateMany({
        where: { id, status: 'DEAD', deadAt },
        data: { status: 'ACTIVE', deadAt: null, lastError: null, lastOkAt: now },
      });
      return count === 1;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}
