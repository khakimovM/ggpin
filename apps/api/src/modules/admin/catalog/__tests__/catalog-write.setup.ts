import type { Clock } from '../../../../common/clock/clock';
import { AppError } from '../../../../common/exceptions/app-error';
import { AdminCatalogWriteService } from '../admin-catalog-write.service';
import { FakeAlerts, FakeCatalogRepo } from './catalog-write.fake';

// Shared by the catalog write service unit tests (S8a): the service on the in-memory fakes.

const clock: Clock = { now: () => new Date('2026-11-22T10:00:00.000Z') };

export function setup() {
  const fake = new FakeCatalogRepo();
  const alerts = new FakeAlerts(fake.calls);
  return { fake, alerts, service: new AdminCatalogWriteService(fake, alerts, clock) };
}

/** The refusal as the owner services shape it (`validationError(field, reason)`). */
export async function refusal(work: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A valid new-package body. */
export const pkg = {
  labelUz: '75 ta',
  labelRu: '75 шт',
  quantity: 75,
  markupBps: 1200,
  minMarginTiyin: '0',
  isActive: true,
  sort: 3,
};
