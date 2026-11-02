import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'ggpin:public';

// Opt a controller or handler out of the global UserAuthGuard (rules/10-backend-nestjs.md).
// Every route needs a session unless it says otherwise here: health probes, the login
// endpoints themselves, and callers that prove themselves another way (the Telegram webhook's
// secret header, payment providers' signatures).
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);
