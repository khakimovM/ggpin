import { SetMetadata } from '@nestjs/common';

export const ADMIN_PUBLIC_KEY = 'ggpin:admin-public';

/**
 * The admin login routes (start, status, verify): no session yet. AdminCsrfGuard still checks
 * Origin, Sec-Fetch-* and, on POST, the CSRF header; the per-IP @Throttle budgets still apply.
 * Nothing else on the admin surface may use it.
 */
export const AdminPublic = (): MethodDecorator => SetMetadata(ADMIN_PUBLIC_KEY, true);
