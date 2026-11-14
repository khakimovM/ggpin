import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { TonNetwork } from './ton-mnemonic';
import type { PrismaHolder } from './ton-transfer.repository';

/** The hot wallet's balance readings (`WalletSnapshot`, immutable rows; docs/03). */
@Injectable()
export class TonSnapshotRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  /**
   * One reading; the id is the `refId` of a low-balance alert. The TON hot wallet holds no USDT
   * (Fragment is paid in TON), so `microUsdt` is 0 until a USDT balance exists to read.
   */
  async record(network: TonNetwork, address: string, nanoTon: bigint): Promise<string> {
    const row = await this.prisma.client.walletSnapshot.create({
      data: { network, address, nanoTon, microUsdt: 0n },
      select: { id: true },
    });
    return row.id;
  }
}
