import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@repo/db';
import { RECIPIENT_CHECK_REUSE_MS, type RecipientCheckRequest } from '@repo/shared';
import { TG_USERNAME_FORM } from './recipient-test-doubles';

// Products for the validate-recipient e2e suites (scratch `_test` database), removed again after
// the suite, and the API producer's job id (apps/api recipient-check.client.ts, D-61) rebuilt
// here: the worker never imports the API.

let counter = 0;

/** A per-run tag: lower-case letters and digits. */
export const tag = (): string =>
  `${Date.now().toString(36)}${(++counter).toString(36)}${randomBytes(3).toString('hex')}`;

/** A fresh valid username (letter first, <= 32 chars) with a prefix such as `notfound_`. */
export const username = (prefix = 'u'): string => `${prefix}${tag()}`.slice(0, 32);

/** `vr-` + SHA-256 over product, normalized input (sorted keys) and the 60 s bucket. */
export function recipientCheckJobId(request: RecipientCheckRequest, now: Date): string {
  const bucket = Math.floor(now.getTime() / RECIPIENT_CHECK_REUSE_MS);
  const input = Object.keys(request.input)
    .sort()
    .map((key) => [key, request.input[key]]);
  const canonical = JSON.stringify([request.productId, input, bucket]);
  return `vr-${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface ProductOptions {
  /** The route's adapter; null = no route at all. Default FRAGMENT. */
  readonly adapter?: string | null;
  readonly isActive?: boolean;
  readonly inputSchema?: Prisma.InputJsonValue;
}

export class RecipientProducts {
  private readonly productIds: string[] = [];
  private readonly categoryIds: string[] = [];

  constructor(private readonly db: () => PrismaClient) {}

  async create(options: ProductOptions = {}): Promise<string> {
    const t = tag();
    const db = this.db();
    const category = await db.category.create({
      data: { slug: `vr-cat-${t}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
    });
    this.categoryIds.push(category.id);
    const product = await db.product.create({
      data: {
        slug: `vr-prod-${t}`,
        categoryId: category.id,
        nameUz: 'Mahsulot',
        nameRu: 'Товар',
        imageUrl: 'https://example.test/p.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: options.inputSchema ?? [...TG_USERNAME_FORM],
        isActive: options.isActive ?? true,
      },
    });
    this.productIds.push(product.id);
    const adapter = options.adapter === undefined ? 'FRAGMENT' : options.adapter;
    if (adapter !== null) {
      await db.productRoute.create({ data: { productId: product.id, adapter, priority: 1 } });
    }
    return product.id;
  }

  async removeAll(): Promise<void> {
    const db = this.db();
    await db.productRoute.deleteMany({ where: { productId: { in: this.productIds } } });
    await db.product.deleteMany({ where: { id: { in: this.productIds } } });
    await db.category.deleteMany({ where: { id: { in: this.categoryIds } } });
  }
}
