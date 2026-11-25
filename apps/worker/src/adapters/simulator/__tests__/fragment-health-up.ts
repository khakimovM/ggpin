import type { FragmentHealthSource } from '../../../fulfillment/adapter-registry';

/** A Fragment session that is always up: registries built outside the Nest graph in tests. */
export const FRAGMENT_UP: FragmentHealthSource = {
  simulatedAdapterHealth: () => Promise.resolve('OK'),
};
