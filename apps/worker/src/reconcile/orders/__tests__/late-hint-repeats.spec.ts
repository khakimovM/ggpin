import { NOTIFY_DEDUPE_SEC } from '@repo/shared';
import {
  HINT_REPEAT_MAX_AGE_MS,
  decidedHintOf,
  insideDedupeWindow,
  isMarkOf,
} from '../late-hint-repeats';

// S9i re-review M1/M2: a decided hint's alert is queued again only while its audit row is younger
// than the notify dedupe less one day (the API's EFFECTS_REPLAY_MAX_AGE_MS margin), in ms on the
// database clock: inside it (a day before the edge) yes, at the edge and past it no.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const ago = (ms: number): Date => new Date(NOW - ms);

describe('insideDedupeWindow (M1, M2)', () => {
  it('the window is the notify dedupe less one day: 29 days, in milliseconds', () => {
    expect(NOTIFY_DEDUPE_SEC).toBe(30 * 86_400);
    expect(HINT_REPEAT_MAX_AGE_MS).toBe(29 * DAY);
  });

  it('inside, close to the edge (a day before it): queued again', () => {
    expect(insideDedupeWindow(ago(0), NOW)).toBe(true);
    expect(insideDedupeWindow(ago(HINT_REPEAT_MAX_AGE_MS - DAY), NOW)).toBe(true);
    expect(insideDedupeWindow(ago(HINT_REPEAT_MAX_AGE_MS - 1), NOW)).toBe(true);
  });

  it('at the edge and past it (the margin day and the dedupe itself): never', () => {
    expect(insideDedupeWindow(ago(HINT_REPEAT_MAX_AGE_MS), NOW)).toBe(false);
    expect(insideDedupeWindow(ago(HINT_REPEAT_MAX_AGE_MS + DAY / 2), NOW)).toBe(false);
    expect(insideDedupeWindow(ago(NOTIFY_DEDUPE_SEC * 1_000), NOW)).toBe(false);
  });
});

describe('decidedHintOf / isMarkOf', () => {
  const T1 = 'cmh1transfer000000000001';
  const T2 = 'cmh1transfer000000000002';

  it('reads the kept verdict: code and the other transfer of an OTHER_TRANSFER', () => {
    const response = {
      ton: {
        hint: {
          auditId: 'a1',
          verdict: 'REJECTED',
          code: 'OTHER_TRANSFER',
          message: `OTHER_TRANSFER(${T1})`,
        },
      },
    };
    expect(decidedHintOf(response)).toEqual({
      auditId: 'a1',
      code: 'OTHER_TRANSFER',
      otherTransferId: T1,
    });
    expect(decidedHintOf({ ton: { hint: { auditId: 'a2', verdict: 'ACCEPTED' } } })).toEqual({
      auditId: 'a2',
      code: null,
      otherTransferId: null,
    });
    expect(decidedHintOf({ ton: {} })).toBeNull();
    expect(decidedHintOf(null)).toBeNull();
  });

  it('the mark must be this very hint’s: OTHER_TRANSFER, the same audit and hinted transfer', () => {
    const late = { outcome: 'OTHER_TRANSFER', auditId: 'a1', hintedTransferId: T2 };
    expect(isMarkOf({ ton: { late } }, 'a1', T2)).toBe(true);
    expect(isMarkOf({ ton: { late } }, 'a2', T2)).toBe(false);
    expect(isMarkOf({ ton: { late } }, 'a1', T1)).toBe(false);
    expect(isMarkOf({ ton: { late: { ...late, outcome: 'CONFIRMED' } } }, 'a1', T2)).toBe(false);
    expect(isMarkOf({ ton: {} }, 'a1', T2)).toBe(false);
  });
});
