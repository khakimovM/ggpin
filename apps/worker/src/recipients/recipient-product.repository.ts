import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';

/** What a recipient check needs to know about a product. `inputSchema` is unparsed JSON. */
export interface RecipientCheckProduct {
  readonly id: string;
  readonly slug: string;
  readonly isActive: boolean;
  readonly inputSchema: unknown;
}

@Injectable()
export class RecipientProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(productId: string): Promise<RecipientCheckProduct | null> {
    return this.prisma.client.product.findUnique({
      where: { id: productId },
      select: { id: true, slug: true, isActive: true, inputSchema: true },
    });
  }
}
