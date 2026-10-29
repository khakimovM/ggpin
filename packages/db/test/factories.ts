import type { Order, PaymentIntent, Quote, User } from '../src/index';
import { db } from './client';

let counter = 0;
const next = (): number => ++counter;

export async function createUser(): Promise<User> {
  const n = next();
  return db.user.create({
    data: { telegramId: BigInt(1_000_000 + n), referralCode: `ref${n}-${Date.now()}` },
  });
}

export async function createQuote(userId: string): Promise<Quote> {
  const n = next();
  const category = await db.category.create({
    data: { slug: `cat-${n}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
  });
  const product = await db.product.create({
    data: {
      slug: `prod-${n}`,
      categoryId: category.id,
      nameUz: 'Mahsulot',
      nameRu: 'Товар',
      imageUrl: 'https://example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [],
    },
  });
  const fxRate = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '30000.5', source: 'test' },
  });
  return db.quote.create({
    data: {
      userId,
      productId: product.id,
      quantity: 50,
      recipient: { username: 'someone' },
      costCurrency: 'TON',
      costMinor: 1_000_000_000n,
      fxRateId: fxRate.id,
      priceTiyin: 5_000_000n,
      maxCostMinor: 1_100_000_000n,
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
}

export async function createOrder(user: User, idempotencyKey = `key-${next()}`): Promise<Order> {
  const quote = await createQuote(user.id);
  return db.order.create({
    data: {
      userId: user.id,
      quoteId: quote.id,
      productId: quote.productId,
      quantity: quote.quantity,
      recipient: { username: 'someone' },
      priceTiyin: quote.priceTiyin,
      costCurrency: quote.costCurrency,
      costMinor: quote.costMinor,
      maxCostMinor: quote.maxCostMinor,
      status: 'PAID',
      idempotencyKey,
      requestHash: 'hash-a',
    },
  });
}

export async function createIntent(
  userId: string,
  idempotencyKey = `ik-${next()}`,
): Promise<PaymentIntent> {
  return db.paymentIntent.create({
    data: {
      userId,
      provider: 'CLICK',
      amountTiyin: 1_000_000n,
      purpose: 'TOPUP',
      idempotencyKey,
      requestHash: 'hash-a',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
}
