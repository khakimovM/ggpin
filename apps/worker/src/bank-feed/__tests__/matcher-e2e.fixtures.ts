import { randomBytes } from 'node:crypto';
import type { PrismaClient, TopupCard, TopupCardStatus } from '@repo/db';
import { bankTextSha256 } from '../message-integrity';
import { parseBankMessage } from '../parsers/parse-bank-message';
import { PARSER_VERSION } from '../parsers/parser-version';
import { uzcardText } from './synthetic-message';

// Rows for the matcher e2e on the shared ggpin_test database. Everything is SYNTHETIC (E-29)
// and unique per run: PAN prefix 9998 + this holder (the API suites use 9999 + their own), user
// telegram ids and the bot sender id derived from the clock, amounts from a counter. Runs are
// serialised by the e2e lock; `retireSuiteCards` leaves no live card behind, because the API
// payments suites refuse to start next to a foreign live card.

export const SUITE_HOLDER = 'WORKER E2E HOLDER';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const GRACE_MS = 24 * HOUR;
export const BASE_TIYIN = 5_000_000n; // 50 000 so'm

let seq = 0;
const next = (): number => ++seq;
const runSeed = BigInt(Date.now());
/** The pinned "bot" of this run (synthetic). */
export const SENDER_ID = 900_000_000_000n + (runSeed % 1_000_000n);
let messageSeq = runSeed * 1_000n;

/** A fresh unique pay amount: BASE + n so'm (n = 1..999 within a run). */
export function uniqueAmount(): bigint {
  return BASE_TIYIN + BigInt((next() % 999) + 1) * 100n;
}

export async function createUser(
  db: PrismaClient,
  opts: { createdAt?: Date; isBlocked?: boolean; locale?: 'uz' | 'ru' } = {},
) {
  const n = next();
  return db.user.create({
    data: {
      telegramId: runSeed * 1_000n + BigInt(n),
      referralCode: `wk${randomBytes(6).toString('hex')}`,
      firstName: 'Test',
      locale: opts.locale ?? 'uz',
      isBlocked: opts.isBlocked ?? false,
      createdAt: opts.createdAt ?? new Date(),
      wallet: { create: {} },
    },
  });
}

export interface CardOptions {
  readonly status?: TopupCardStatus;
  readonly limitTiyin?: bigint;
  readonly monthlyLimitTiyin?: bigint | null;
  readonly verifyAmountTiyin?: bigint;
  readonly paused?: boolean;
}

/** A card with a last4 no live card has (retried on the partial unique). */
export async function createCard(db: PrismaClient, opts: CardOptions = {}): Promise<TopupCard> {
  const status = opts.status ?? 'ACTIVE';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const digits = randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000;
    const pan = `9998${String(digits).padStart(12, '0')}`;
    try {
      return await db.topupCard.create({
        data: {
          bank: 'UZCARD',
          pan,
          last4: pan.slice(-4),
          holderName: SUITE_HOLDER,
          status,
          receiveLimitTiyin: opts.limitTiyin ?? 1_000_000_000_000n,
          monthlyLimitTiyin: opts.monthlyLimitTiyin ?? null,
          verifyAmountTiyin: opts.verifyAmountTiyin ?? 112_300n,
          autoCreditPaused: opts.paused ?? false,
          verifiedAt: status === 'VERIFYING' ? null : new Date(Date.now() - 10 * 24 * HOUR),
        },
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'P2002')) throw error;
    }
  }
  throw new Error('no free synthetic last4');
}

export interface IntentOptions {
  readonly amountTiyin: bigint;
  readonly status?: 'PENDING' | 'EXPIRED' | 'CANCELLED' | 'PAID';
  readonly createdAt?: Date;
  /** Request lifetime, default 30 min. */
  readonly ttlMs?: number;
  readonly paidAt?: Date;
  readonly baseAmountTiyin?: bigint;
}

export function createIntent(db: PrismaClient, userId: string, cardId: string, o: IntentOptions) {
  const createdAt = o.createdAt ?? new Date(Date.now() - 5 * MINUTE);
  const expiresAt = new Date(createdAt.getTime() + (o.ttlMs ?? 30 * MINUTE));
  const paidAt = o.status === 'PAID' ? (o.paidAt ?? createdAt) : null;
  const reservedUntil = new Date(
    Math.max(expiresAt.getTime() + GRACE_MS, (paidAt?.getTime() ?? 0) + GRACE_MS),
  );
  return db.paymentIntent.create({
    data: {
      userId,
      provider: 'P2P_CARD',
      cardId,
      amountTiyin: o.amountTiyin,
      baseAmountTiyin: o.baseAmountTiyin ?? BASE_TIYIN,
      status: o.status ?? 'PENDING',
      purpose: 'TOPUP',
      idempotencyKey: `wk-${String(next())}-${randomBytes(4).toString('hex')}`,
      requestHash: 'h',
      createdAt,
      expiresAt,
      reservedUntil,
      paidAt,
    },
  });
}

export interface MessageOptions {
  readonly card: Pick<TopupCard, 'id' | 'last4'> | null;
  readonly last4?: string;
  readonly direction?: 'CREDIT' | 'DEBIT';
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
  /** Telegram's date; default one minute ago. */
  readonly tgDate?: Date;
  /** The time the bank prints; default = tgDate. */
  readonly bankTxnAt?: Date;
  readonly title?: string | null;
  /** Integrity tests: another sender than the pinned one, or a hash of another text. */
  readonly senderId?: bigint;
  readonly textSha256?: string;
  /** When the row was stored (BankMessage.createdAt); default now. D-47 tests set it. */
  readonly storedAt?: Date;
  /** The raw text is already past its retention (purgeAfter in the past), ready to purge. */
  readonly purgeable?: boolean;
  /** An exact purgeAfter (wins over `purgeable`), e.g. days in the past for an overdue purge. */
  readonly purgeAfter?: Date;
}

/** Stores one parsed message the way the listener (S7) will: row + raw text, card at ingestion. */
export async function insertMessage(db: PrismaClient, o: MessageOptions) {
  const tgDate = o.tgDate ?? new Date(Date.now() - MINUTE);
  const last4 = o.card?.last4 ?? o.last4 ?? '0000';
  const text = uzcardText({
    direction: o.direction ?? 'CREDIT',
    amountTiyin: o.amountTiyin,
    balanceAfterTiyin: o.balanceAfterTiyin,
    last4,
    bankTxnAt: o.bankTxnAt ?? tgDate,
    ...(o.title === undefined ? {} : { title: o.title }),
  });
  const parsed = parseBankMessage('UZCARD_BOT', text);
  if (!parsed.ok) throw new Error(`synthetic message did not parse: ${parsed.reason}`);
  messageSeq += 1n;
  return db.bankMessage.create({
    data: {
      source: 'UZCARD_BOT',
      senderId: o.senderId ?? SENDER_ID,
      tgMessageId: messageSeq,
      tgDate,
      textSha256: o.textSha256 ?? bankTextSha256(text),
      parseStatus: 'PARSED',
      parserVersion: PARSER_VERSION,
      direction: parsed.direction,
      amountTiyin: parsed.amountTiyin,
      balanceAfterTiyin: parsed.balanceAfterTiyin,
      last4: parsed.last4,
      bankTxnAt: parsed.bankTxnAt,
      channel: parsed.channel,
      cardId: o.card?.id ?? null,
      ...(o.storedAt === undefined ? {} : { createdAt: o.storedAt }),
      rawText: {
        create: {
          text,
          purgeAfter:
            o.purgeAfter ??
            new Date(Date.now() + (o.purgeable === true ? -MINUTE : 365 * 24 * HOUR)),
        },
      },
    },
  });
}

/** An UNRECOGNIZED / REJECTED row: only the reason code, no parsed fields. */
export function insertUnparsed(
  db: PrismaClient,
  status: 'UNRECOGNIZED' | 'REJECTED',
  reason: string,
) {
  messageSeq += 1n;
  return db.bankMessage.create({
    data: {
      source: 'UZCARD_BOT',
      senderId: SENDER_ID,
      tgMessageId: messageSeq,
      tgDate: new Date(Date.now() - MINUTE),
      textSha256: bankTextSha256('TEST'),
      parseStatus: status,
      rejectReason: reason,
      parserVersion: PARSER_VERSION,
      rawText: { create: { text: 'TEST', purgeAfter: new Date(Date.now() + 365 * 24 * HOUR) } },
    },
  });
}

/** Cancels what still waits on this suite's cards and retires them (RETIRED is final). */
export async function retireSuiteCards(db: PrismaClient): Promise<void> {
  const cards = await db.topupCard.findMany({
    where: { holderName: SUITE_HOLDER, status: { not: 'RETIRED' } },
    select: { id: true },
  });
  const ids = cards.map((c) => c.id);
  if (ids.length === 0) return;
  await db.paymentIntent.updateMany({
    where: { cardId: { in: ids }, status: 'PENDING' },
    data: { status: 'CANCELLED', payTokenHash: null },
  });
  await db.topupCard.updateMany({
    where: { id: { in: ids } },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}
