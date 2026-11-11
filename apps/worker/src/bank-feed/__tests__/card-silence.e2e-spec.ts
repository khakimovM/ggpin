import { createPrismaClient, type PrismaClient } from '@repo/db';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { CardSilenceRepository } from '../card-silence.repository';
import { HOUR, createCard, insertMessage, retireSuiteCards } from './matcher-e2e.fixtures';

// The card silence read (r3, review CR-6) on the real ggpin_test DB: one newest-first read per
// ACTIVE verified card, same answer as before (the last PARSED CREDIT, or verifiedAt when no
// credit came after it). The DB is shared, so only this file's cards are asserted.
let db: PrismaClient;
let repo: CardSilenceRepository;

beforeAll(async () => {
  db = createPrismaClient(buildE2eEnv().DATABASE_URL);
  await retireSuiteCards(db);
  repo = new CardSilenceRepository({ client: db } as unknown as PrismaService);
});

afterAll(async () => {
  await retireSuiteCards(db);
  await db.$disconnect();
});

const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

describe('CardSilenceRepository.activeCardsQuietSince', () => {
  it('the last PARSED CREDIT per card (a later DEBIT does not count), else verifiedAt', async () => {
    const credited = await createCard(db); // verifiedAt 10 days ago
    const quiet = await createCard(db);
    const oldCredit = await createCard(db);
    const draining = await createCard(db, { status: 'DRAINING' });
    const verifying = await createCard(db, { status: 'VERIFYING' });
    const money = { amountTiyin: 5_000_000n, balanceAfterTiyin: 9_000_000n };
    await insertMessage(db, { card: credited, ...money, tgDate: ago(120) });
    const last = await insertMessage(db, { card: credited, ...money, tgDate: ago(72) });
    await insertMessage(db, { card: credited, ...money, direction: 'DEBIT', tgDate: ago(24) });
    await insertMessage(db, { card: oldCredit, ...money, tgDate: ago(20 * 24) });
    await insertMessage(db, { card: draining, ...money, tgDate: ago(1) });

    const rows = await repo.activeCardsQuietSince();
    const mine = new Map(rows.map((r) => [r.cardId, r.since]));
    expect(mine.get(credited.id)).toEqual(last.tgDate);
    expect(mine.get(quiet.id)).toEqual(quiet.verifiedAt);
    expect(mine.get(oldCredit.id)).toEqual(oldCredit.verifiedAt); // the credit predates it
    expect(mine.has(draining.id)).toBe(false);
    expect(mine.has(verifying.id)).toBe(false);
  });
});
