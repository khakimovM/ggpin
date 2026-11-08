import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Tx } from '@repo/db';
import {
  BANK_OF_SOURCE,
  QUEUES,
  alertRef,
  bankMessageJobId,
  type BankFeedSource,
  type IngestRejectReason,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { bankMessageJobSchema } from '../bank-message.processor';
import { BankFeedNotifier } from '../bank-feed-notifier';
import { bankTextSha256 } from '../message-integrity';
import { parseBankMessage } from '../parsers/parse-bank-message';
import { PARSER_VERSION } from '../parsers/parser-version';
import { isUniqueViolationOn } from '../prisma-errors';
import type { BankFeedMessage } from './bank-feed-client';
import { HourlyCounter } from './hourly-counter';
import { ingestRejectReason, isForeignText } from './ingest-filter';

export const BANK_MESSAGE_JOB_NAME = 'bank-message';
/** The raw text is kept for the owner's review for one year (D-37 (10)), then purged. */
export const RAW_TEXT_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;
/** The unique key of a stored message (BankMessage @@unique([senderId, tgMessageId])). */
const MESSAGE_KEY = {
  index: 'BankMessage_senderId_tgMessageId_key',
  columns: ['senderId', 'tgMessageId'],
} as const;

/** The source has no pinned bot id: nothing of it can be accepted (and nothing is stored). */
export class SourceNotPinnedError extends Error {
  constructor(readonly source: BankFeedSource) {
    super(`no pinned bot id for ${source}`);
    this.name = 'SourceNotPinnedError';
  }
}

export type IngestResult =
  | { readonly stored: true; readonly bankMessageId: string }
  | {
      readonly stored: false;
      /** DUPLICATE: already stored. FOREIGN_CHAT: another chat's message, refused unstored. */
      readonly reason: 'DUPLICATE' | 'FOREIGN_CHAT';
    };

/**
 * The ordinary ingest path (docs/05 §4, plan S7): acceptance filter -> parse -> ONE transaction
 * that stores the `BankMessage` row with its raw text (hash next to it) and moves the source's
 * cursor forward (never back) -> the `bank-message` job (`bm-<id>`). The S7 listener and the
 * daily re-scan (S9) both go through it, so a message is stored the same way whoever found it.
 * The card is set from (bank, last4): the live card, or else the latest RETIRED one with those
 * digits (the matcher then says CARD_RETIRED, not CARD_UNKNOWN). A message already stored (the
 * unique (senderId, tgMessageId)) is left as it is. A message of ANOTHER CHAT is not stored at
 * all and does not move the cursor (B2): its id belongs to another chat's numbering, so it could
 * push the cursor past real messages, or take the (senderId, tgMessageId) key a real message of
 * the bot's own chat needs later; the owner gets a `foreignChat` security alert instead. Another
 * sender or a non-bot in the bot's chat (FOREIGN_SENDER / NOT_BOT) is stored with its hash only.
 * Logs name the source and the code only: never the text, an amount, a balance or card digits.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private readonly foreignChats = new HourlyCounter();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.BANK_MESSAGE) private readonly queue: Queue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly notifier: BankFeedNotifier,
  ) {}

  /** The pinned bot of a source, or null when it is not configured. */
  pinnedBot(source: BankFeedSource): bigint | null {
    const id =
      source === 'HUMO_BOT'
        ? this.config.BANK_FEED_HUMO_BOT_ID
        : this.config.BANK_FEED_UZCARD_BOT_ID;
    return id ?? null;
  }

  async ingest(
    source: BankFeedSource,
    message: BankFeedMessage,
    now: Date = new Date(),
  ): Promise<IngestResult> {
    const pinned = this.pinnedBot(source);
    if (pinned === null) throw new SourceNotPinnedError(source);
    const rejected = ingestRejectReason(message, pinned);
    if (rejected === 'FOREIGN_CHAT') {
      // A security event, never silent: logged (codes and a count only) and alerted, both once an
      // hour per source, so a busy foreign chat cannot flood the log (S9 F-I1).
      const hit = this.foreignChats.hit(source, now);
      if (hit.logNow) {
        this.logger.warn(
          `ingest source=${source} refused a message of another chat (not stored); ` +
            `refused in the previous logged hour: ${String(hit.previousLoggedHourCount)}`,
        );
      }
      await this.notifier.alert('foreignChat', alertRef.foreignChat(source, now));
      return { stored: false, reason: 'FOREIGN_CHAT' };
    }
    let bankMessageId: string;
    try {
      bankMessageId = await this.prisma.client.$transaction(async (tx) => {
        const id = await this.store(tx, source, message, rejected, now);
        await this.advanceCursor(tx, source, message.id);
        return id;
      });
    } catch (error) {
      // Only the message key means "already stored"; any other violation is a real error.
      if (isUniqueViolationOn(error, MESSAGE_KEY)) return { stored: false, reason: 'DUPLICATE' };
      throw error;
    }
    const data = bankMessageJobSchema.parse({ bankMessageId });
    await this.queue.add(BANK_MESSAGE_JOB_NAME, data, { jobId: bankMessageJobId(bankMessageId) });
    return { stored: true, bankMessageId } satisfies IngestResult;
  }

  private async store(
    tx: Tx,
    source: BankFeedSource,
    message: BankFeedMessage,
    rejected: IngestRejectReason | null,
    now: Date,
  ): Promise<string> {
    // Another sender's or a non-bot's words are not kept: the hash only.
    const rawText = isForeignText(rejected)
      ? {}
      : {
          rawText: {
            create: {
              text: message.text,
              purgeAfter: new Date(now.getTime() + RAW_TEXT_RETENTION_DAYS * DAY_MS),
            },
          },
        };
    const base = {
      source,
      senderId: message.senderId,
      tgMessageId: message.id,
      tgDate: message.date,
      textSha256: bankTextSha256(message.text),
      parserVersion: PARSER_VERSION,
      ...rawText,
    };
    const parsed = rejected === null ? parseBankMessage(source, message.text) : null;
    if (parsed === null || !parsed.ok) {
      const row = await tx.bankMessage.create({
        data: {
          ...base,
          parseStatus: rejected === null ? 'UNRECOGNIZED' : 'REJECTED',
          rejectReason: rejected ?? parsed?.reason ?? null,
        },
        select: { id: true },
      });
      return row.id;
    }
    const cardId = await this.cardFor(tx, source, parsed.last4);
    const row = await tx.bankMessage.create({
      data: {
        ...base,
        parseStatus: 'PARSED',
        direction: parsed.direction,
        amountTiyin: parsed.amountTiyin,
        balanceAfterTiyin: parsed.balanceAfterTiyin,
        last4: parsed.last4,
        bankTxnAt: parsed.bankTxnAt,
        channel: parsed.channel,
        cardId,
      },
      select: { id: true },
    });
    return row.id;
  }

  private async cardFor(tx: Tx, source: BankFeedSource, last4: string): Promise<string | null> {
    const bank = BANK_OF_SOURCE[source];
    // At most one live card per (bank, last4): a partial unique index (migration p4_wallet_p2p_checks).
    const live = await tx.topupCard.findFirst({
      where: { bank, last4, status: { not: 'RETIRED' } },
      select: { id: true },
    });
    if (live !== null) return live.id;
    const retired = await tx.topupCard.findFirst({
      where: { bank, last4, status: 'RETIRED' },
      orderBy: [{ retiredAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return retired?.id ?? null;
  }

  // GREATEST: a re-scan finds ids below the listener's cursor and must never move it back.
  private async advanceCursor(tx: Tx, source: BankFeedSource, messageId: bigint): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "BankFeedCursor" ("source", "lastMessageId", "createdAt", "updatedAt")
      VALUES (${source}::"BankFeedSource", ${messageId}, now(), now())
      ON CONFLICT ("source") DO UPDATE
        SET "lastMessageId" = GREATEST("BankFeedCursor"."lastMessageId", EXCLUDED."lastMessageId"),
            "updatedAt" = now()`;
  }
}
