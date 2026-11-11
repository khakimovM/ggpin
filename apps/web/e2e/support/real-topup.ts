import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { connectE2eClient } from './real-db';
import type { BankName } from './real-worker';

// Rows the top-up journeys need in the e2e database (never anywhere else: connectE2eClient refuses
// any other database). The receiving card is SYNTHETIC: a made-up PAN with a 999x prefix (the
// project's convention for synthetic cards, which the backend test suites use too; this one is
// 9996) and a made-up holder, never a real card. Nothing here deletes or truncates: leftovers of
// an interrupted run are RETIRED, which is what a card's last state is anyway.

/** The holder of every card these journeys create: how a leftover is told from anyone else's. */
const HOLDER = 'WEB E2E HOLDER';
const BIG_LIMIT_TIYIN = 1_000_000_000_000n;

export interface TestCard {
  id: string;
  bank: BankName;
  /** 16 digits, as the API hands it to the payer. */
  pan: string;
  last4: string;
}

async function withClient<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  // Connected and checked on `current_database()`: it is the e2e database or nothing is sent.
  const client = await connectE2eClient();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Retires the cards of earlier (interrupted) runs, so only the new one is offered to the payer. */
async function retireLeftovers(client: pg.Client): Promise<void> {
  await client.query(
    `UPDATE "TopupCard" SET status = 'RETIRED', "retiredAt" = now(), "updatedAt" = now()
     WHERE "holderName" = $1 AND status <> 'RETIRED'`,
    [HOLDER],
  );
}

/** An ACTIVE card with a huge receive limit: it always has the most free capacity. */
export async function createTestCard(bank: BankName): Promise<TestCard> {
  return withClient(async (client) => {
    await retireLeftovers(client);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const digits = randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000;
      const pan = `9996${String(digits).padStart(12, '0')}`;
      const last4 = pan.slice(-4);
      const taken = await client.query(
        `SELECT 1 FROM "TopupCard" WHERE bank = $1::"CardBank" AND last4 = $2 AND status <> 'RETIRED'`,
        [bank, last4],
      );
      if (taken.rowCount !== 0) continue;
      const id = `webe2e${randomBytes(10).toString('hex')}`;
      await client.query(
        `INSERT INTO "TopupCard"
           (id, bank, pan, last4, "holderName", status, "receiveLimitTiyin", "verifyAmountTiyin",
            "verifiedAt", "updatedAt")
         VALUES ($1, $2::"CardBank", $3, $4, $5, 'ACTIVE', $6, 112300, now() - interval '10 days', now())`,
        [id, bank, pan, last4, HOLDER, BIG_LIMIT_TIYIN.toString()],
      );
      return { id, bank, pan, last4 };
    }
    throw new Error('No free synthetic last4 for a test card.');
  });
}

/** The card's end: RETIRED (final), so no later run or request ever meets it again. */
export async function retireTestCard(card: TestCard): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE "TopupCard" SET status = 'RETIRED', "retiredAt" = now(), "updatedAt" = now()
       WHERE id = $1 AND status <> 'RETIRED'`,
      [card.id],
    );
  });
}

export interface LedgerRow {
  kind: string;
  amountTiyin: string;
  refType: string;
}

/** The user's ledger straight from the database, oldest first (the proof under the API's answer). */
export async function ledgerOf(telegramId: number): Promise<LedgerRow[]> {
  return withClient(async (client) => {
    const result = await client.query<LedgerRow>(
      `SELECT l.kind::text AS kind, l."amountTiyin"::text AS "amountTiyin", l."refType"::text AS "refType"
       FROM "LedgerEntry" l JOIN "User" u ON u.id = l."userId"
       WHERE u."telegramId" = $1 ORDER BY l."createdAt", l.id`,
      [telegramId],
    );
    return result.rows;
  });
}

/** How many reviews (money the matcher would not credit by itself) exist for this card. */
export async function reviewKindsOfCard(card: TestCard): Promise<string[]> {
  return withClient(async (client) => {
    const result = await client.query<{ kind: string }>(
      `SELECT r.kind::text AS kind FROM "PaymentReview" r
       JOIN "BankMessage" m ON m.id = r."bankMessageId" WHERE m."cardId" = $1 ORDER BY r."createdAt"`,
      [card.id],
    );
    return result.rows.map((row) => row.kind);
  });
}
