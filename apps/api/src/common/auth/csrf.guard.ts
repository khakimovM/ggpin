import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER } from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { AppError } from '../exceptions/app-error';
import { corsOrigins } from '../http/cors-origins';
import type { AuthRequest } from './auth-user';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Global guard, registered after UserAuthGuard (D-26). A state-changing request needs BOTH
//   * a non-empty X-CSRF-Token header (a cross-site page cannot add a custom header without a
//     CORS preflight, which the origin allowlist refuses), and
//   * an Origin that is one of our own frontends (browsers always send it on cross-site POSTs).
// Applies to @Public() routes too: login CSRF (a victim's browser submitting an attacker's
// nonce/code) is real. Exempt: @SkipCsrf() routes and requests authenticated by a Bearer token
// (the Mini App), where the credential is not ambient and a foreign page cannot attach it.
// A failure is NOT_FOUND (a generic 403 would be mapped to the same thing): the response must
// not tell a probe that the route exists.
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.allowedOrigins = new Set(corsOrigins(config));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip === true) return true;
    // Only a Bearer token the auth guard actually accepted counts, never the bare header.
    if (request.authUser?.channel === 'tg') return true;

    const token = request.headers[CSRF_HEADER];
    const origin = request.headers['origin'];
    const hasToken = typeof token === 'string' && token.trim() !== '';
    const originAllowed = typeof origin === 'string' && this.allowedOrigins.has(origin);
    if (!hasToken || !originAllowed) throw new AppError('NOT_FOUND');
    return true;
  }
}
