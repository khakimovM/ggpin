import { Module } from '@nestjs/common';
import { PriceBookService } from './price-book.service';
import { PricingRepository } from './pricing.repository';

@Module({
  providers: [PricingRepository, PriceBookService],
  exports: [PriceBookService],
})
export class PricingModule {}
