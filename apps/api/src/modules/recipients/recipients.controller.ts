import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { ValidateRecipientResponse } from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { ValidateRecipientBodyDto } from './dto/recipients.dto';
import { RecipientsService } from './recipients.service';

// docs/04 `POST /recipients/validate`: a session route (cookie sessions pass the global CsrfGuard:
// X-CSRF-Token + Origin, D-26; Mini App Bearer requests do not need it). The answer is per user
// and holds a token, so the default `no-store` stays (no @PublicCache). 200, not 201: nothing the
// client can address is created. The per-user limit lives in the service; the global per-IP
// throttle still applies.
@Controller('recipients')
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(
    @CurrentUser('id') userId: string,
    @Body() body: ValidateRecipientBodyDto,
  ): Promise<ValidateRecipientResponse> {
    return this.recipients.validate(userId, body);
  }
}
