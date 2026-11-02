import {
  Body,
  Controller,
  Get,
  Injectable,
  Post,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Public } from '../auth/public.decorator';
import { SkipCsrf } from '../auth/skip-csrf.decorator';
import { AppError } from '../exceptions/app-error';
import { paginated } from '../http/with-meta';

const EchoSchema = z
  .object({
    amount: z.string().regex(/^\d+$/),
    note: z.string().max(10),
  })
  .strict();

class EchoDto extends createZodDto(EchoSchema) {}

// A guard that refuses: Nest turns a false return into ForbiddenException (D-26: 404 NOT_FOUND).
@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

// Test-only routes (registered by the e2e test module, never by AppModule) that exercise each
// branch of the global pipeline: envelope, BigInt, pagination, validation, domain and
// unexpected errors. @Public() and @SkipCsrf() keep these tests about the pipeline itself:
// without them the global UserAuthGuard / CsrfGuard would answer first and every case here
// (including the POSTs without X-CSRF-Token) would stop being what it claims to test. The
// guards have their own specs (guard-order, auth-webapp e2e).
@Public()
@SkipCsrf()
@Controller('pipeline-test')
export class HttpTestController {
  @Get('ok')
  ok(): { id: string; amountTiyin: bigint; lines: { qty: bigint }[]; at: Date } {
    return {
      id: 'x',
      amountTiyin: 9_007_199_254_740_993n,
      lines: [{ qty: 2n }],
      at: new Date('2026-10-30T10:00:00.000Z'),
    };
  }

  @Get('nothing')
  nothing(): undefined {
    return undefined;
  }

  @Get('page')
  page(): ReturnType<typeof paginated<{ priceTiyin: bigint }>> {
    return paginated([{ priceTiyin: 100n }], { page: 2, limit: 20, total: 41 });
  }

  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  // Accepts anything: the logging e2e posts secret-bearing bodies and must reach a 2xx handler.
  @Post('sink')
  sink(@Body() _body: unknown): { received: true } {
    return { received: true };
  }

  @Get('domain-error')
  domainError(): never {
    throw new AppError('INSUFFICIENT_BALANCE', {
      balance: 100n,
      required: 250n,
      shortfall: 150n,
    });
  }

  @Get('guard-denied')
  @UseGuards(DenyGuard)
  guardDenied(): { reached: true } {
    return { reached: true };
  }

  @Get('blocked-user')
  blockedUser(): never {
    throw new AppError('USER_BLOCKED');
  }

  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED postgres://ggpin:hunter2@db:5432');
  }
}
