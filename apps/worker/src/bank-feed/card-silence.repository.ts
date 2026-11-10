import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';

/** An ACTIVE card and when it last received money (or was verified, if never since). */
export interface CardQuietSince {
  readonly cardId: string;
  readonly since: Date;
}

/**
 * The reads of the card silence check (docs/05 §2 "Jimlik aniqlanishi", D-52 r2 M-C). Prisma
 * only here (rules/20). Per ACTIVE card one newest-first read on the `(cardId, tgDate)` index.
 */
@Injectable()
export class CardSilenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every ACTIVE, verified card with the bot time of its last PARSED CREDIT, or its verifiedAt
   * when no credit came after it (a card just put in service is measured from its verification).
   */
  async activeCardsQuietSince(): Promise<CardQuietSince[]> {
    const cards = await this.prisma.client.topupCard.findMany({
      where: { status: 'ACTIVE', verifiedAt: { not: null } },
      select: { id: true, verifiedAt: true },
      orderBy: { id: 'asc' },
    });
    const result: CardQuietSince[] = [];
    for (const card of cards) {
      if (card.verifiedAt === null) continue;
      // Newest first on the (cardId, tgDate) index (r3, review CR-6): the scan walks back only to
      // the first PARSED CREDIT instead of grouping the whole history of every card.
      const credit = await this.prisma.client.bankMessage.findFirst({
        where: { cardId: card.id, parseStatus: 'PARSED', direction: 'CREDIT' },
        orderBy: { tgDate: 'desc' },
        select: { tgDate: true },
      });
      const at = credit?.tgDate ?? null;
      // The real last credit or verifiedAt: the alert refId (card + since) stays stable.
      result.push({
        cardId: card.id,
        since: at !== null && at > card.verifiedAt ? at : card.verifiedAt,
      });
    }
    return result;
  }
}
