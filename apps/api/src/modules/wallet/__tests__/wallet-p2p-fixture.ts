import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../../../infra/prisma/prisma.service';

type Client = PrismaService['client'];

const MINUTE_MS = 60_000;
/** TOPUP_LATE_GRACE_SEC (24 h): how long a unique amount stays reserved after its request ends. */
const GRACE_MS = 24 * 60 * MINUTE_MS;

export interface P2pPaymentOptions {
  /** Whole thousands of so'm in tiyin (a multiple of 100 000). */
  readonly baseTiyin: bigint;
  /** The unique suffix, 100..99 900 tiyin in whole so'm. Default 12 300 (123 so'm). */
  readonly suffixTiyin?: bigint;
  /** What the TOPUP ledger entry credited; default = the payment amount. */
  readonly creditedTiyin?: bigint;
}

export interface P2pPayment {
  readonly paymentId: string;
  /** base + suffix: the exact amount of the intent, the bank message and the payment. */
  readonly amountTiyin: bigint;
  readonly cardId: string;
  readonly intentId: string;
}

const randomDigits = (count: number): string =>
  Array.from(randomBytes(count), (byte) => String(byte % 10)).join('');

/** An ACTIVE, verified card. Two live cards may not share (bank, last4): retry on a clash. */
async function createCard(db: Client): Promise<{ id: string; last4: string }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pan = `8600${randomDigits(12)}`;
    try {
      const card = await db.topupCard.create({
        data: {
          bank: 'UZCARD',
          pan,
          last4: pan.slice(-4),
          holderName: 'TEST HOLDER',
          status: 'ACTIVE',
          receiveLimitTiyin: 100_000_000_000n,
          verifyAmountTiyin: 1_234_500n,
          verifiedAt: new Date(),
        },
        select: { id: true, last4: true },
      });
      return card;
    } catch (error) {
      if (attempt === 9) throw error;
    }
  }
  throw new Error('unreachable');
}

/**
 * A CONFIRMED P2P_CARD payment shaped as the worker leaves it, and accepted by the database
 * guards: an ACTIVE verified card; a PARSED CREDIT bank message for that card (last4 and exact
 * amount); a P2P intent for the same card and amount that ends PAID with
 * reservedUntil = GREATEST(old, paidAt + grace); the Payment itself; the TOPUP ledger entry.
 * Each call uses its own card so equal amounts never meet in the per-card reservation index.
 */
export async function createP2pPayment(
  db: Client,
  seedTopup: (paymentId: string, amountTiyin: bigint) => Promise<unknown>,
  cards: string[],
  userId: string,
  options: P2pPaymentOptions,
): Promise<P2pPayment> {
  const amountTiyin = options.baseTiyin + (options.suffixTiyin ?? 12_300n);
  const tag = randomBytes(6).toString('hex');
  const card = await createCard(db);
  cards.push(card.id);

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * MINUTE_MS);
  const intent = await db.paymentIntent.create({
    data: {
      userId,
      provider: 'P2P_CARD',
      cardId: card.id,
      baseAmountTiyin: options.baseTiyin,
      amountTiyin,
      purpose: 'TOPUP',
      status: 'PENDING',
      idempotencyKey: `idem_${tag}`,
      requestHash: `hash_${tag}`,
      createdAt,
      expiresAt,
      reservedUntil: new Date(expiresAt.getTime() + GRACE_MS),
    },
  });

  const senderId = 1_000n;
  const tgMessageId = BigInt(`0x${randomBytes(6).toString('hex')}`);
  const message = await db.bankMessage.create({
    data: {
      source: 'UZCARD_BOT',
      senderId,
      tgMessageId,
      tgDate: new Date(),
      textSha256: `sha_${tag}`,
      parseStatus: 'PARSED',
      parserVersion: 1,
      direction: 'CREDIT',
      amountTiyin,
      balanceAfterTiyin: amountTiyin + 10_000_000n,
      last4: card.last4,
      cardId: card.id,
      bankTxnAt: new Date(),
    },
  });

  const payment = await db.payment.create({
    data: {
      intentId: intent.id,
      userId,
      provider: 'P2P_CARD',
      providerTxnId: `${String(senderId)}:${String(tgMessageId)}`,
      amountTiyin,
      status: 'CONFIRMED',
      raw: {},
      bankMessageId: message.id,
      confirmedAt: new Date(),
    },
  });

  // The guard accepts exactly GREATEST(old reservedUntil, paidAt + grace), grace being the gap
  // fixed at creation.
  const paidAt = new Date();
  const grace = intent.reservedUntil
    ? intent.reservedUntil.getTime() - intent.expiresAt.getTime()
    : GRACE_MS;
  const reservedUntil = new Date(
    Math.max(intent.reservedUntil?.getTime() ?? 0, paidAt.getTime() + grace),
  );
  await db.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'PAID', paidAt, reservedUntil },
  });

  await seedTopup(payment.id, options.creditedTiyin ?? amountTiyin);
  return { paymentId: payment.id, amountTiyin, cardId: card.id, intentId: intent.id };
}

/** Cards are final once RETIRED, and a retired card frees its (bank, last4) for later runs. */
export async function retireCards(db: Client, cardIds: readonly string[]): Promise<void> {
  if (cardIds.length === 0) return;
  await db.topupCard.updateMany({
    where: { id: { in: [...cardIds] }, status: { not: 'RETIRED' } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}
