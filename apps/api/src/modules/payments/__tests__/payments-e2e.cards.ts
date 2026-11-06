import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { TEST_HOLDER } from './payments.fixtures';

// The cards this suite makes are synthetic (PAN prefix 9999 + this holder name). Suites run one
// at a time (e2e lock + --runInBand), so a 9999 test card that is live when a file starts was
// left by a crashed run: it is retired before the file runs. Any other live card on the test DB
// belongs to someone else and would change what the allocator picks: the file stops at once.
export async function prepareCardPool(db: PrismaService['client']): Promise<void> {
  const leftovers = await db.topupCard.findMany({
    where: { status: { not: 'RETIRED' }, pan: { startsWith: '9999' }, holderName: TEST_HOLDER },
    select: { id: true },
  });
  await retire(
    db,
    leftovers.map((c) => c.id),
  );
  const foreign = await db.topupCard.count({ where: { status: { not: 'RETIRED' } } });
  if (foreign > 0) {
    throw new Error(`payments e2e: ${String(foreign)} foreign live TopupCard rows on the test DB`);
  }
}

// Cancels what may still wait on the cards (PENDING -> CANCELLED is a legal move; the amount
// stays reserved), then retires them. RETIRED is final, so a card is never reused.
export async function retire(db: PrismaService['client'], ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.paymentIntent.updateMany({
    where: { cardId: { in: [...ids] }, status: 'PENDING' },
    data: { status: 'CANCELLED', payTokenHash: null },
  });
  await db.topupCard.updateMany({
    where: { id: { in: [...ids] }, status: { not: 'RETIRED' } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}
