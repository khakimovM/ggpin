import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** What validating a recipient needs to know about a product. */
export interface RecipientProduct {
  readonly id: string;
  readonly isActive: boolean;
  /** Raw `Product.inputSchema`; the service parses it with the shared schema. */
  readonly inputSchema: Prisma.JsonValue;
}

@Injectable()
export class RecipientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The product in any state, or null when the id is unknown. Catalog rows are not per user. */
  findProduct(productId: string): Promise<RecipientProduct | null> {
    return this.prisma.client.product.findUnique({
      where: { id: productId },
      select: { id: true, isActive: true, inputSchema: true },
    });
  }
}
