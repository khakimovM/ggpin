import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'ggpin:raw-response';

// Opt a controller or handler out of the `{ success, data }` envelope. Only for routes whose
// body is fixed by an external consumer (health probes, D-24; provider callbacks whose reply
// format the provider dictates). Everything else is enveloped.
export const RawResponse = (): ClassDecorator & MethodDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);
