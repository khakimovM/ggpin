import { Module } from '@nestjs/common';
import { RECIPIENT_CHECK_TIMEOUT_MS } from '@repo/shared';
import { RECIPIENT_CHECK_WAIT_MS, RecipientCheckClient } from './recipient-check.client';
import { RecipientCheckGate } from './recipient-check.gate';
import { RecipientTokenStore } from './recipient-token.store';
import { RecipientsController } from './recipients.controller';
import { RecipientsRepository } from './recipients.repository';
import { RecipientsService } from './recipients.service';

// `POST /recipients/validate` asks the worker over the validate-recipient queue (QueueModule is
// global) and issues the token that `POST /quotes` resolves (QuotesModule imports the store).
@Module({
  controllers: [RecipientsController],
  providers: [
    RecipientTokenStore,
    RecipientsRepository,
    RecipientsService,
    RecipientCheckClient,
    RecipientCheckGate,
    { provide: RECIPIENT_CHECK_WAIT_MS, useValue: RECIPIENT_CHECK_TIMEOUT_MS },
  ],
  exports: [RecipientTokenStore],
})
export class RecipientsModule {}
