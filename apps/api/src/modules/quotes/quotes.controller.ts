import { Body, Controller, Post } from '@nestjs/common';
import type { QuoteResponse } from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { CreateQuoteBodyDto } from './dto/quotes.dto';
import { QuotesService } from './quotes.service';

// Per-user limiting lives in the service; the global per-IP throttle still applies. The response
// carries a per-user price: never @PublicCache, so the default `no-store` stays.
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() body: CreateQuoteBodyDto,
  ): Promise<QuoteResponse> {
    return this.quotes.create(userId, body);
  }
}
