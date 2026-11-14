import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { DEFAULT_RECIPIENT_CHECK_TIMING, RECIPIENT_CHECK_TIMING } from './recipient-check.config';
import { RecipientJobSweeper } from './recipient-job-sweeper';
import { RecipientLookupService } from './recipient-lookup.service';
import { RecipientProductRepository } from './recipient-product.repository';
import { ValidateRecipientProcessor } from './validate-recipient.processor';

// The `validate-recipient` consumer (phase 5 S3b, docs/06). The adapters and the router are the
// worker's one shared set (AdaptersModule, also imported by FulfillmentModule): the same adapter
// instance (and, from S7/S8, the same provider session) answers checks and fulfils orders.
@Module({
  imports: [AdaptersModule],
  providers: [
    { provide: RECIPIENT_CHECK_TIMING, useValue: DEFAULT_RECIPIENT_CHECK_TIMING },
    RecipientProductRepository,
    RecipientLookupService,
    ValidateRecipientProcessor,
    RecipientJobSweeper,
  ],
})
export class RecipientsModule {}
