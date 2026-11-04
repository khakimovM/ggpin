import { Module } from '@nestjs/common';
import { RecipientTokenStore } from './recipient-token.store';

// Phase 3 ships the token store only; the validate endpoint (Fragment lookup) is phase 5.
@Module({ providers: [RecipientTokenStore], exports: [RecipientTokenStore] })
export class RecipientsModule {}
