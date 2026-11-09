import { Injectable } from '@nestjs/common';
import { BankTextPurgeRepository } from './bank-text-purge.repository';

/** Rows per UPDATE: short row locks, one index range each. */
export const BANK_TEXT_PURGE_BATCH = 1_000;
/** Batches per run; a larger backlog continues the next day (the job is idempotent). */
export const BANK_TEXT_PURGE_MAX_BATCHES = 100;

export interface BankTextPurgeResult {
  /** Rows whose raw text this run erased. */
  readonly purged: number;
  readonly batches: number;
  /** The run stopped at BANK_TEXT_PURGE_MAX_BATCHES with full batches: rows may be left. */
  readonly more: boolean;
}

/**
 * The daily raw-text purge (docs/05 §10, D-37 (10)): every BankMessageText whose `purgeAfter`
 * has passed loses its text, in batches. The BankMessage row, its outcome, review and payment
 * stay; the paths that read the text treat NULL as purged (integrity skips the hash check, the
 * title check says TEXT_MISSING, `review:show` prints "(purged)"). A second run finds nothing
 * (`text IS NOT NULL` is part of the predicate). Moves no money; the caller logs counts only.
 */
@Injectable()
export class BankTextPurgeService {
  constructor(private readonly repo: BankTextPurgeRepository) {}

  async run(
    batchSize: number = BANK_TEXT_PURGE_BATCH,
    maxBatches: number = BANK_TEXT_PURGE_MAX_BATCHES,
  ): Promise<BankTextPurgeResult> {
    let purged = 0;
    let batches = 0;
    for (;;) {
      const changed = await this.repo.purgeBatch(batchSize);
      purged += changed;
      batches += 1;
      // A short batch means nothing was left when it ran.
      if (changed < batchSize) return { purged, batches, more: false };
      if (batches >= maxBatches) return { purged, batches, more: true };
    }
  }
}
