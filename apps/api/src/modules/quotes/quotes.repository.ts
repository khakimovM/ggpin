import { Injectable } from '@nestjs/common';
import type { Prisma, Product, Quote, Sku } from '@repo/db';
import type { CostCurrency, Recipient } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

export type QuoteProduct = Product & { readonly skus: readonly Sku[] };

export interface NewQuote {
  readonly productId: string;
  /** Null for a custom quantity (priced from the product-level cost). */
  readonly skuId: string | null;
  readonly quantity: number;
  readonly recipient: Recipient;
  /**
   * The recipient's provider-side id from the validate call (docs/06 S2). Internal: written once
   * (the DB refuses any later change) and copied to the order; never in a response or a log.
   */
  readonly providerRef: string;
  readonly costCurrency: CostCurrency;
  readonly costMinor: bigint;
  readonly fxRateId: string;
  readonly costSnapshotId: string;
  readonly priceTiyin: bigint;
  readonly maxCostMinor: bigint;
  readonly expiresAt: Date;
}

// Prisma's Json input rejects `undefined` members: list the fields instead of spreading.
function recipientJson(recipient: Recipient): Prisma.InputJsonObject {
  return {
    username: recipient.username,
    displayName: recipient.displayName,
    ...(recipient.photoUrl === undefined ? {} : { photoUrl: recipient.photoUrl }),
  };
}

@Injectable()
export class QuotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The product (any state) with its ACTIVE packs, smallest first; null when unknown. */
  findProductWithActiveSkus(productId: string): Promise<QuoteProduct | null> {
    return this.prisma.client.product.findUnique({
      where: { id: productId },
      include: {
        skus: { where: { isActive: true }, orderBy: [{ quantity: 'asc' }, { id: 'asc' }] },
      },
    });
  }

  create(userId: string, quote: NewQuote): Promise<Quote> {
    return this.prisma.client.quote.create({
      data: {
        userId,
        productId: quote.productId,
        skuId: quote.skuId,
        quantity: quote.quantity,
        recipient: recipientJson(quote.recipient),
        providerRef: quote.providerRef,
        costCurrency: quote.costCurrency,
        costMinor: quote.costMinor,
        fxRateId: quote.fxRateId,
        costSnapshotId: quote.costSnapshotId,
        priceTiyin: quote.priceTiyin,
        maxCostMinor: quote.maxCostMinor,
        discountCodeId: null,
        expiresAt: quote.expiresAt,
      },
    });
  }
}
