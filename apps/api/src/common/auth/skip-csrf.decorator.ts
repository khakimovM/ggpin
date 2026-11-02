import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'ggpin:skip-csrf';

// Opt a route out of the CSRF check (X-CSRF-Token + Origin allowlist, D-26). Only for callers
// that are not browsers and prove themselves another way: the Telegram webhook (secret header)
// and payment-provider callbacks (signatures). Never for a route a browser session can call.
export const SkipCsrf = (): ClassDecorator & MethodDecorator => SetMetadata(SKIP_CSRF_KEY, true);
