import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { OwnerAlertRenderer } from '../owner-alert.renderer';

// The OwnerAlertRenderer test double shared by owner-alert.renderer.spec.ts and
// owner-alert.bank-feed.spec.ts.
// Only the reads these cases use; awaited like the Prisma promises they stand for.
interface Sources {
  review: () => Promise<unknown>;
  heartbeat: () => Promise<string | null>;
  payment: () => Promise<unknown>;
  message: () => Promise<unknown>;
  card: () => Promise<unknown>;
  reconcileRun: (day: string) => Promise<unknown>;
}

export const NOW = new Date('2030-01-01T09:00:00.000Z');

export function renderer(sources: Partial<Sources>): OwnerAlertRenderer {
  const fake: Sources = {
    review: () => Promise.resolve(null),
    heartbeat: () => Promise.resolve(null),
    payment: () => Promise.resolve(null),
    message: () => Promise.resolve(null),
    card: () => Promise.resolve(null),
    reconcileRun: () => Promise.resolve(null),
    ...sources,
  };
  return new OwnerAlertRenderer(fake as unknown as NotifySourcesRepository, buildTestEnv(), {
    now: () => NOW,
  });
}
