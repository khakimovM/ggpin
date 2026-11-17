import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** What an `AdminOrderRow` is built from: never the idempotency key or the request hash. */
export const ADMIN_ORDER_ROW_SELECT = {
  id: true,
  number: true,
  createdAt: true,
  user: { select: { id: true, username: true } },
  product: { select: { id: true, slug: true, nameUz: true } },
  sku: { select: { id: true, labelUz: true } },
  quantity: true,
  recipient: true,
  priceTiyin: true,
  discountTiyin: true,
  costCurrency: true,
  costMinor: true,
  fxRate: { select: { pair: true, rate: true } },
  status: true,
  statusReason: true,
  deliveredAt: true,
  attempts: { select: { adapter: true }, orderBy: { attemptNo: 'desc' }, take: 1 },
} as const satisfies Prisma.OrderSelect;

export type AdminOrderRowSource = Prisma.OrderGetPayload<{ select: typeof ADMIN_ORDER_ROW_SELECT }>;

/** Orders as the admin lists them (newest first). The orders screen itself is S10 (9-B). */
@Injectable()
export class AdminOrderRowsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async ofUser(
    userId: string,
    page: { skip: number; take: number },
  ): Promise<{ rows: AdminOrderRowSource[]; total: number }> {
    const where = { userId };
    const [rows, total] = await this.prisma.client.$transaction([
      this.prisma.client.order.findMany({
        where,
        select: ADMIN_ORDER_ROW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
      this.prisma.client.order.count({ where }),
    ]);
    return { rows, total };
  }
}
