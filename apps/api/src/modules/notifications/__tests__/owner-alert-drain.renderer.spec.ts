import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { AlertSourceMissingError, OwnerAlertRenderer } from '../owner-alert.renderer';

// S9b: the card-drain alerts and the purge mismatch code (the other alerts are in
// owner-alert.renderer.spec.ts). Only the reads these cases use.
interface Sources {
  card: () => Promise<unknown>;
  reconcileRun: (day: string) => Promise<unknown>;
}

function renderer(sources: Partial<Sources>): OwnerAlertRenderer {
  const fake: Sources = {
    card: () => Promise.resolve(null),
    reconcileRun: () => Promise.resolve(null),
    ...sources,
  };
  return new OwnerAlertRenderer(fake as unknown as NotifySourcesRepository, buildTestEnv(), {
    now: () => new Date('2030-01-01T09:00:00.000Z'),
  });
}

describe('OwnerAlertRenderer: card drain and text purge (S9b)', () => {
  it.each([
    ['cardDraining', 'UZCARD kartasi ***4321 yopilmoqda'],
    ['cardDrained', 'UZCARD kartasi ***4321 ishdan chiqarildi'],
  ] as const)('%s names the card by bank and last4, never its number', async (alert, phrase) => {
    const pan = '9999000011114321';
    const r = renderer({
      card: () => Promise.resolve({ id: 'c1', bank: 'UZCARD', last4: '4321', pan }),
    });
    const text = await r.render(alert, 'c1');
    expect(text).toContain(phrase);
    expect(text).not.toContain(pan);
    expect(text).not.toContain('99990000');
    await expect(renderer({}).render(alert, 'gone')).rejects.toBeInstanceOf(
      AlertSourceMissingError,
    );
  });

  it('L2: a raw text kept past its purge date is listed as purgeOverdue, last in order', async () => {
    const after = {
      count: 3,
      debits: 0,
      openReviews: 0,
      historyScan: 'ok',
      mismatches: { purgeOverdue: 2, recovered: 1 },
    };
    const r = renderer({ reconcileRun: () => Promise.resolve({ after }) });
    const text = await r.render('reconcileMismatch', '20300504');
    expect(text).toContain('Farqlar soni: 3 (recovered=1, purgeOverdue=2)');
  });
});
