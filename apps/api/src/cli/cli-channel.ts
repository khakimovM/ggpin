import type { Provider } from '@nestjs/common';
import { OPERATOR_CHANNEL, cliChannelForCliModule } from '../modules/orders/admin/operator-channel';

/**
 * The one place the CLI channel is provided (plan S10, audit I-4): OpsCliModule, the module graph
 * of the owner CLI binary. The HTTP application never registers it, so the owner order and FX
 * services, which inject it, cannot be built there, and no `type: 'CLI'` resolver can be minted
 * in the HTTP process. A test keeps this provider (and the channel factory) out of every other file.
 */
export const CLI_CHANNEL_PROVIDER: Provider = {
  provide: OPERATOR_CHANNEL,
  useValue: cliChannelForCliModule(),
};
