import { Controller, Get, Header, Headers, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PAY_TOKEN_HEADER, type PayView } from '@repo/shared';
import { Public } from '../../common/auth/public.decorator';
import { PAY_VIEW_ROUTE } from '../../common/http/api-path';
import { PayViewService } from './pay-view.service';

/** Per client IP (IPv6 /64, HttpPipelineModule): many payers share one carrier IP (D-29). */
export const PAY_VIEW_IP_LIMIT = { default: { limit: 300, ttl: 60_000 } };

// The pay page's only data source (D-39). No session: the capability token in `X-Pay-Token`
// (a header, so it never lands in an access log) opens exactly one intent, read-only. GET, so no
// CSRF. CORS is chosen per path: this prefix gets `payViewCorsPolicy` (WEB_URL only, no
// credentials, GET, `X-Pay-Token` allowed), applied by `applyCors` through `corsPolicyFor`
// (cors-origins.ts, security-headers.ts); no other path allows that header. `Cache-Control:
// no-store` comes from the global cache policy; the referrer policy is repeated here so the route keeps it even
// if the global helmet default ever changes.
@Controller(PAY_VIEW_ROUTE)
@Public()
export class PayLinkController {
  constructor(private readonly payView: PayViewService) {}

  // The param is a plain string on purpose: a schema would answer 400 for a malformed id, and
  // every failure here must be the same 404 (the service resolves anything it cannot to 404).
  @Get(':intentId')
  @Throttle(PAY_VIEW_IP_LIMIT)
  @Header('Referrer-Policy', 'no-referrer')
  read(
    @Param('intentId') intentId: string,
    @Headers(PAY_TOKEN_HEADER) token: unknown,
  ): Promise<PayView> {
    // A repeated header can arrive as an array: anything but one string is "no token".
    return this.payView.read(intentId, typeof token === 'string' ? token : undefined);
  }
}
