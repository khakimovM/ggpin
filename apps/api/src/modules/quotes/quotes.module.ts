import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { RecipientsModule } from '../recipients/recipients.module';
import { QuotesController } from './quotes.controller';
import { QuotesRepository } from './quotes.repository';
import { QuotesService } from './quotes.service';

// Its own module (not part of PricingModule): the price book is a read-only service the catalog
// shares, while a quote is a user-owned row that phase 5 orders consume.
@Module({
  imports: [PricingModule, RecipientsModule],
  controllers: [QuotesController],
  providers: [QuotesRepository, QuotesService],
})
export class QuotesModule {}
