import { Injectable, Logger } from '@nestjs/common';
import { cardReservedHighRef } from '@repo/shared';
import { reservedShareHigh, tashkentMonthStart } from './card-capacity';
import { CardPoolRepository } from './card-pool.repository';
import { PaymentsAlerts } from './payments-alerts';

/**
 * D-42 (1): after a request is created on a card, the owner hears when unpaid reservations
 * hold more than half of what the card may still receive (a create-and-cancel farm, or a card
 * that needs a higher limit). One alert per card per clock hour: the job id carries the hour,
 * so BullMQ drops the repeats. Best effort: the request is already committed, so a failure here
 * is logged with the card id only and never reaches the caller.
 */
@Injectable()
export class CardReservedAlert {
  private readonly logger = new Logger(CardReservedAlert.name);

  constructor(
    private readonly pool: CardPoolRepository,
    private readonly alerts: PaymentsAlerts,
  ) {}

  async checkAfterCreate(cardId: string, now: Date): Promise<void> {
    try {
      const [totals] = await this.pool.cardTotals(this.pool.client, {
        now,
        monthStart: tashkentMonthStart(now),
        statuses: ['ACTIVE', 'FULL', 'DRAINING'],
        autoCreditOnly: false,
        cardId,
      });
      if (totals === undefined || !reservedShareHigh(totals)) return;
      await this.alerts.raise('cardReservedHigh', cardReservedHighRef(cardId, now));
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(`reserved share check for card ${cardId} skipped: ${reason}`);
    }
  }
}
