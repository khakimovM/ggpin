import { Injectable } from '@nestjs/common';
import { LoginRequestRepository, type LoginRequestKind } from '../../auth/login-request.repository';

/**
 * The web login's repository, scoped to `LoginRequest.kind = 'ADMIN'`: every claim, deny,
 * attempt, release and code count of the admin panel sees admin rows only, and the web login
 * never sees them.
 */
@Injectable()
export class AdminLoginRequestRepository extends LoginRequestRepository {
  protected override readonly kind: LoginRequestKind = 'ADMIN';
}
