import { Injectable } from '@nestjs/common';
import { ADMIN_FX_PAIRS, type AdminFxRate } from '@repo/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';

type Pair = AdminFxRate['pair'];
const isPair = (value: string): value is Pair =>
  (ADMIN_FX_PAIRS as readonly string[]).includes(value);

/** Stored FX rates, newest first (the worker's sync, the derived TON_UZS, manual rates). */
@Injectable()
export class AdminFxReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async history(pair: Pair | undefined, page: { skip: number; take: number }) {
    // Only the known pairs: a stray pair name in the table is not a rate the panel can show.
    const where = { pair: pair ?? { in: [...ADMIN_FX_PAIRS] } };
    const [rows, total] = await this.prisma.client.$transaction([
      this.prisma.client.fxRate.findMany({
        where,
        select: { id: true, pair: true, rate: true, source: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
      this.prisma.client.fxRate.count({ where }),
    ]);
    return {
      rows: rows.flatMap((row) => (isPair(row.pair) ? [{ ...row, pair: row.pair }] : [])),
      total,
    };
  }
}
