import { Controller, Get, Query } from '@nestjs/common';
import type { LedgerItem, WalletResponse } from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { WithMeta } from '../../common/http/with-meta';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { WalletService } from './wallet.service';

// Both answers are per user, so the default `no-store` stays (no @PublicCache). The routes sit
// under `me` next to UsersController, whose paths are `/me` only: no clash. The adjust and
// reversal services are deliberately NOT exposed over HTTP (owner CLI only, docs/05 section 9).
@Controller('me')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  getWallet(@CurrentUser('id') userId: string): Promise<WalletResponse> {
    return this.wallet.getWallet(userId);
  }

  @Get('ledger')
  listLedger(
    @CurrentUser('id') userId: string,
    @Query() query: LedgerQueryDto,
  ): Promise<WithMeta<readonly LedgerItem[]>> {
    return this.wallet.listLedger(userId, query);
  }
}
