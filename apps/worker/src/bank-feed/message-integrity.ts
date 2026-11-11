import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { BankMessage, Tx } from '@repo/db';
import type { ReviewNoteCode } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { BankMessageRepository } from './bank-message.repository';

/** `BankMessage.textSha256`: lowercase hex SHA-256 of the raw text's UTF-8 bytes. */
export function bankTextSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type IntegrityNote = Extract<ReviewNoteCode, 'SENDER_MISMATCH' | 'TEXT_HASH_MISMATCH'>;

/**
 * Defence in depth on a stored PARSED message before it may move money (docs/05 §4, §6, L3):
 * the listener already accepts only the pinned bot of each source, and stores the text with its
 * hash in one transaction. The matcher checks both again, so a row written by anything else (a
 * bug, a hand-made insert, a tampered text) is never credited. A purged text (NULL after the
 * retention period) has nothing to hash; the credit path then stops on TEXT_MISSING anyway.
 * Nothing here is logged: the text and the ids stay in the database.
 */
@Injectable()
export class MessageIntegrity {
  constructor(
    private readonly reads: BankMessageRepository,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async check(tx: Tx, message: BankMessage): Promise<IntegrityNote | null> {
    const pinned =
      message.source === 'HUMO_BOT'
        ? this.config.BANK_FEED_HUMO_BOT_ID
        : this.config.BANK_FEED_UZCARD_BOT_ID;
    // No pinned id configured (allowed outside production only) proves nothing: fail closed.
    if (pinned === undefined || pinned !== message.senderId) return 'SENDER_MISMATCH';
    const text = await this.reads.rawText(tx, message.id);
    if (text !== null && bankTextSha256(text) !== message.textSha256) return 'TEXT_HASH_MISMATCH';
    return null;
  }
}
