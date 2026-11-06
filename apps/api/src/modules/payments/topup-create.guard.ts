import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { AuthRequest } from '../../common/auth/auth-user';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { TopupLimits } from './topup-limits';

/**
 * The request-rate limits of `POST /payments/intents` (5 / 10 min, 10 created / 24 h). A guard,
 * not a service step, because the contract checks them BEFORE validation (docs/04 "Tekshiruv
 * tartibi") and Nest runs guards before pipes: a script sending malformed bodies is limited
 * too. Route guards run after the global UserAuthGuard, so `authUser` is set.
 */
@Injectable()
export class TopupCreateGuard implements CanActivate {
  constructor(
    private readonly limits: TopupLimits,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<AuthRequest>().authUser;
    if (user === undefined) throw new AppError('UNAUTHORIZED');
    await this.limits.enforceRequestRate(user.id, this.clock.now());
    return true;
  }
}
