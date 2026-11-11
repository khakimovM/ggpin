import { Inject, Injectable } from '@nestjs/common';
import type { TopupCardStatus } from '@repo/db';
import { receivedUsagePercent, tashkentMonthStart } from '@repo/shared';
import { CLOCK, type Clock } from '../common/clock/clock';
import { CardPoolRepository } from '../modules/payments/card-pool.repository';
import { money } from './commands/command';

const LIVE: readonly TopupCardStatus[] = ['VERIFYING', 'ACTIVE', 'FULL', 'DRAINING'];
const ALL: readonly TopupCardStatus[] = [...LIVE, 'RETIRED'];

/**
 * `card:list`: one line per card from the shared capacity query (`cardTotals`, D-42 (1)), so the
 * owner sees the same received / held sums the allocator and the worker use. Id, bank and last4
 * only: never the PAN or the holder name.
 */
@Injectable()
export class CardListing {
  constructor(
    private readonly pool: CardPoolRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(all: boolean): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.pool.cardTotals(this.pool.client, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: all ? ALL : LIVE,
      autoCreditOnly: false,
    });
    return rows.map((totals) => {
      const card = totals.card;
      return [
        card.id,
        `${card.bank}*${card.last4}`,
        card.status,
        card.autoCreditPaused ? 'PAUSED' : 'auto',
        `limit=${money(card.receiveLimitTiyin)}`,
        `monthly=${money(card.monthlyLimitTiyin)}`,
        `received=${money(totals.receivedTiyin)}`,
        `month=${money(totals.receivedMonthTiyin)}`,
        `held=${money(totals.reservedTiyin)}`,
        `used=${String(receivedUsagePercent(totals))}%`,
      ].join('  ');
    });
  }
}
