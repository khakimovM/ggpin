import { Inject, Injectable, Logger } from '@nestjs/common';
import { FX_MAX_JUMP_BPS, multiplyRates, type FxPair } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { exceedsJumpLimit } from './fx-jump-guard';
import {
  FX_SOURCE,
  FxQuoteSchema,
  SOURCED_FX_PAIRS,
  type FxQuote,
  type FxSource,
  type SourcedFxPair,
} from './fx-sources/fx-source';
import {
  PricingSyncRepository,
  type FxRateStore,
  type StoredFxRate,
} from './pricing-sync.repository';

export interface FxSyncResult {
  /** Pairs stored in this run, TON_UZS last when it was derived. */
  readonly written: readonly FxPair[];
  /** Sourced pairs NOT stored: missing/invalid in the source answer or blocked by the jump guard. */
  readonly skipped: readonly SourcedFxPair[];
}

const NOTHING: FxSyncResult = { written: [], skipped: [...SOURCED_FX_PAIRS] };

/**
 * One FX sync run (docs/06 "Narx sinxronlash"): USDT_UZS and TON_USDT from the source, each
 * validated and jump-guarded against the last stored rate of its pair, then TON_UZS derived
 * from the two rows written in THIS run. The derived row is skipped unless both parents were
 * written now, so it never mixes a fresh rate with an old one.
 */
@Injectable()
export class FxSyncService {
  private readonly logger = new Logger(FxSyncService.name);

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(FX_SOURCE) private readonly source: FxSource,
    @Inject(PricingSyncRepository) private readonly repository: FxRateStore,
  ) {}

  async run(): Promise<FxSyncResult> {
    // Fails closed: with dry-run off there is no real source yet, so nothing is written and
    // quotes stop once the last rates pass FX_MAX_AGE_MS (30 min). Never fake data in that mode.
    if (this.source.simulated && !this.config.FULFILLMENT_DRY_RUN) {
      this.logger.error(
        'fx sync: no real FX source is configured and FULFILLMENT_DRY_RUN=false; nothing written',
      );
      return NOTHING;
    }

    const quotes = this.validQuotes(await this.source.fetchRates());
    const accepted: FxQuote[] = [];
    const skipped: SourcedFxPair[] = [];
    for (const pair of SOURCED_FX_PAIRS) {
      const quote = quotes.get(pair);
      if (quote === undefined) {
        skipped.push(pair);
        continue;
      }
      const last = await this.repository.latestFxRate(pair);
      if (last !== null && exceedsJumpLimit(pair, last.rate, quote.rate)) {
        // Rates are public market data, not secrets; the values help the operator judge.
        this.logger.warn(
          `fx sync: ${pair} ${quote.rate} is more than ${FX_MAX_JUMP_BPS} bps away from FxRate ${last.id} (${last.rate}); not written`,
        );
        skipped.push(pair);
        continue;
      }
      accepted.push(quote);
    }

    if (accepted.length === 0) {
      this.logger.warn('fx sync: no rate written in this run');
      return { written: [], skipped };
    }
    const written = await this.repository.writeFxRates(async (insert) => {
      const rows = new Map<SourcedFxPair, StoredFxRate>();
      for (const { pair, rate } of accepted) {
        rows.set(pair, await insert({ pair, rate, source: this.source.name }));
      }
      const pairs: FxPair[] = [...rows.keys()];
      const tonUsdt = rows.get('TON_USDT');
      const usdtUzs = rows.get('USDT_UZS');
      if (tonUsdt !== undefined && usdtUzs !== undefined) {
        await insert({
          pair: 'TON_UZS',
          // Used for COST conversion, so the 18-decimal cut rounds up (never undercharges).
          rate: multiplyRates(tonUsdt.rate, usdtUzs.rate, 'up'),
          source: `derived:${tonUsdt.id}*${usdtUzs.id}`,
        });
        pairs.push('TON_UZS');
      }
      return pairs;
    });

    this.logger.log(`fx sync: wrote ${written.join(', ')} from ${this.source.name}`);
    return { written, skipped };
  }

  // A source answer is untrusted even when typed: each quote is re-validated, and a pair that
  // is invalid or appears twice is dropped (logged without guessing which copy is right).
  private validQuotes(raw: readonly unknown[]): Map<SourcedFxPair, FxQuote> {
    const byPair = new Map<SourcedFxPair, FxQuote>();
    const duplicated = new Set<SourcedFxPair>();
    for (const item of raw) {
      const parsed = FxQuoteSchema.safeParse(item);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? '' : `${issue.path.map(String).join('.')}: `;
        this.logger.warn(
          `fx sync: invalid quote from ${this.source.name} (${where}${issue?.message ?? 'invalid'})`,
        );
        continue;
      }
      if (byPair.has(parsed.data.pair)) duplicated.add(parsed.data.pair);
      byPair.set(parsed.data.pair, parsed.data);
    }
    for (const pair of duplicated) {
      this.logger.warn(`fx sync: ${this.source.name} quoted ${pair} more than once; not written`);
      byPair.delete(pair);
    }
    for (const pair of SOURCED_FX_PAIRS) {
      if (!byPair.has(pair) && !duplicated.has(pair)) {
        this.logger.warn(`fx sync: ${this.source.name} returned no valid ${pair} rate`);
      }
    }
    return byPair;
  }
}
