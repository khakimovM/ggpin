import { AppError } from '../../../common/exceptions/app-error';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { CardAdminService, type AddCardInput } from '../card-admin.service';
import { CardPauseRepository } from '../card-pause.repository';
import { CardPauseService } from '../card-pause.service';
import { notifyJobId } from '@repo/shared';
import { TEST_HOLDER, syntheticPan } from './payments.fixtures';
import type { usePaymentsE2e } from './payments-e2e.helpers';

// Shared by card-admin.e2e-spec.ts and card-admin-security-pause.e2e-spec.ts.
export function cardAdminHelpers(e2e: ReturnType<typeof usePaymentsE2e>) {
  const ACTOR = { operator: 'owner-cli', ip: '203.0.113.5' };
  const admin = () => e2e.app().get(CardAdminService);
  // card:pause / card:resume live in the owner CLI's graph only; built here on the same services.
  const pauses = () =>
    new CardPauseService(admin(), new CardPauseRepository(), e2e.app().get(PrismaService));

  async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown> | undefined> {
    const error: unknown = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof AppError)) throw new Error('expected an AppError');
    return error.details;
  }

  /** A PAN whose last4 no card of these banks on the test DB has ever used (10 000 last4s). */
  async function freshPan(banks: readonly ('HUMO' | 'UZCARD')[] = ['HUMO']): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pan = syntheticPan();
      const used = await e2e.db().topupCard.count({
        where: { bank: { in: [...banks] }, last4: pan.slice(-4) },
      });
      if (used === 0) return pan;
    }
    throw new Error('freshPan: no unused last4 in 50 attempts (clean up the test DB)');
  }

  const input = (pan: string, overrides: Partial<AddCardInput> = {}): AddCardInput => ({
    bank: 'HUMO',
    pan,
    holderName: TEST_HOLDER,
    limitTiyin: 10_000_000_000n,
    reason: 'new receiving card',
    actor: ACTOR,
    ...overrides,
  });

  function track(alert: 'adminAction' | 'cardDraining', refId: string | null): string {
    if (refId === null) throw new Error('expected an id');
    const id = notifyJobId({ kind: 'OWNER_ALERT', alert, refId });
    e2e.trackJob(id);
    return id;
  }

  return { ACTOR, admin, pauses, refusal, freshPan, input, track };
}
