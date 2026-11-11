import { Logger } from '@nestjs/common';
import { alertRef } from '@repo/shared';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import type { CardQuietSince, CardSilenceRepository } from '../card-silence.repository';
import { CardSilenceService } from '../card-silence.service';

// docs/05 §2 "Jimlik aniqlanishi" (D-52 r2, review M-C): 6 DAYTIME hours without a CREDIT on an
// ACTIVE card -> `cardSilent`, one per silent period. Night (Tashkent 00:00-08:00) is not counted.
const at = (iso: string) => new Date(iso);

function setup(cards: CardQuietSince[]) {
  const alerts: string[] = [];
  const alert = jest.fn((kind: string, ref: string) => {
    alerts.push(`${kind}:${ref}`);
    return Promise.resolve();
  });
  const repo = { activeCardsQuietSince: () => Promise.resolve(cards) };
  const service = new CardSilenceService(
    repo as unknown as CardSilenceRepository,
    { alert } as unknown as BankFeedNotifier,
  );
  return { service, alerts, alert, cards };
}

describe('CardSilenceService (docs/05 §2, D-52 r2 M-C)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('alerts a card quiet for 6 daytime hours, once per silent period; a quieter card waits', async () => {
    // 09:00 Tashkent (04:00Z) last credit; now 15:00 Tashkent (10:00Z): 6 daytime hours.
    const since = at('2026-11-04T04:00:00Z');
    const t = setup([
      { cardId: 'cm3silent', since },
      { cardId: 'cm3busy', since: at('2026-11-04T09:30:00Z') },
    ]);
    await expect(t.service.run(at('2026-11-04T10:00:00Z'))).resolves.toEqual({
      alerted: 1,
      failed: 0,
    });
    expect(t.alerts).toEqual([`cardSilent:${alertRef.cardSilent('cm3silent', since)}`]);
    // The next minute: the same period, nothing queued again.
    await expect(t.service.run(at('2026-11-04T10:01:00Z'))).resolves.toEqual({
      alerted: 0,
      failed: 0,
    });
    // A new credit starts a new period: its own alert once that one is 6 hours long.
    t.cards.length = 0;
    t.cards.push({ cardId: 'cm3silent', since: at('2026-11-05T04:00:00Z') });
    await t.service.run(at('2026-11-05T10:00:00Z'));
    expect(t.alerts).toEqual([
      `cardSilent:${alertRef.cardSilent('cm3silent', since)}`,
      `cardSilent:${alertRef.cardSilent('cm3silent', at('2026-11-05T04:00:00Z'))}`,
    ]);
  });

  it('the night is not counted: a credit at 22:00 is not silent at 07:59 next morning', async () => {
    const t = setup([{ cardId: 'cm3night', since: at('2026-11-04T17:00:00Z') }]); // 22:00 local
    await t.service.run(at('2026-11-05T02:59:00Z')); // 07:59 local: 2 daytime hours
    expect(t.alerts).toEqual([]);
    await t.service.run(at('2026-11-05T07:00:00Z')); // 12:00 local: 6 daytime hours
    expect(t.alerts).toHaveLength(1);
  });

  it('an alert that could not be queued is counted and tried again on the next run', async () => {
    const t = setup([{ cardId: 'cm3silent', since: at('2026-11-04T04:00:00Z') }]);
    t.alert.mockRejectedValueOnce(new Error('redis away'));
    const now = at('2026-11-04T10:00:00Z');
    await expect(t.service.run(now)).resolves.toEqual({ alerted: 0, failed: 1 });
    await expect(t.service.run(now)).resolves.toEqual({ alerted: 1, failed: 0 });
  });
});
