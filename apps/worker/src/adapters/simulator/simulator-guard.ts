// The simulator never runs where real money could be meant (plan §8): its constructors refuse a
// production process and any process with FULFILLMENT_DRY_RUN=false. The factory that builds the
// adapter registry decides first; this is the second, independent line.

export class SimulatorRefusedError extends Error {
  constructor(why: string) {
    super(`the fulfillment simulator refuses to run: ${why}`);
    this.name = 'SimulatorRefusedError';
  }
}

export interface SimulatorEnv {
  readonly NODE_ENV: string;
  readonly FULFILLMENT_DRY_RUN: boolean;
}

export function assertSimulatorAllowed(env: SimulatorEnv): void {
  if (env.NODE_ENV === 'production') throw new SimulatorRefusedError('NODE_ENV is production');
  if (!env.FULFILLMENT_DRY_RUN) throw new SimulatorRefusedError('FULFILLMENT_DRY_RUN is false');
}
