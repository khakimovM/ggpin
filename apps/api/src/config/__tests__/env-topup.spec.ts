import { TOPUP_DEFAULTS } from '@repo/shared';
import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE, buildTestEnv } from './test-env';

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv: top-up limits and the owner alert chat', () => {
  it('takes the top-up limits from the shared defaults (D-37): 5 000 .. 2 000 000 so‘m per request', () => {
    const env = buildTestEnv();
    expect(env.TOPUP_MIN_TIYIN).toBe(TOPUP_DEFAULTS.MIN_TIYIN);
    expect(env.TOPUP_MAX_TIYIN).toBe(TOPUP_DEFAULTS.MAX_TIYIN);
    expect(env.TOPUP_MAX_TIYIN).toBe(200_000_000n);
    expect(env.TOPUP_DAILY_MAX_TIYIN).toBe(500_000_000n);
    expect(env.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN).toBe(50_000_000n);
  });

  describe('top-up limits are consistent (checked at boot)', () => {
    const problems = (overrides: Record<string, string>): string[] => {
      try {
        buildTestEnv(overrides);
      } catch (error) {
        if (error instanceof EnvValidationError) return [...error.problems];
        throw error;
      }
      return [];
    };

    it('the defaults are consistent, and TOPUP_STEP_TIYIN exists (1 000 so‘m)', () => {
      expect(problems({})).toEqual([]);
      expect(buildTestEnv().TOPUP_STEP_TIYIN).toBe(TOPUP_DEFAULTS.STEP_TIYIN);
    });

    it.each([
      ['TOPUP_MIN_TIYIN', '0'],
      ['TOPUP_MAX_TIYIN', '0'],
      ['TOPUP_STEP_TIYIN', '0'],
      ['TOPUP_DAILY_MAX_TIYIN', '0'],
      ['TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN', '0'],
    ])('refuses %s=%s', (name, value) => {
      expect(problems({ [name]: value }).join('\n')).toContain(name);
    });

    it('refuses a minimum above the maximum', () => {
      const found = problems({ TOPUP_MIN_TIYIN: '300000000', TOPUP_MAX_TIYIN: '200000000' });
      expect(found.join('\n')).toContain('TOPUP_MIN_TIYIN: must not exceed TOPUP_MAX_TIYIN');
    });

    it('refuses a minimum that is not a multiple of the step', () => {
      const found = problems({ TOPUP_MIN_TIYIN: '550000' });
      expect(found.join('\n')).toContain('TOPUP_MIN_TIYIN: must be a multiple of TOPUP_STEP_TIYIN');
    });

    it('refuses a new-account cap above the general cap', () => {
      const found = problems({ TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '600000000' });
      expect(found.join('\n')).toContain('TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN');
    });

    // The step is tied to the database CHECK (base amount % 100000 = 0): 150 000 would let the
    // API promise amounts the INSERT then rejects.
    it('refuses a step that is not a multiple of the database unit (100000)', () => {
      for (const step of ['50000', '150000', '100001']) {
        const found = problems({ TOPUP_STEP_TIYIN: step });
        expect(found.join('\n')).toContain('TOPUP_STEP_TIYIN: must be a multiple of 100000');
      }
      expect(problems({ TOPUP_STEP_TIYIN: '500000' })).toEqual([]); // a coarser step that still divides every limit
    });

    it('refuses a maximum that is not a multiple of the step', () => {
      const found = problems({ TOPUP_MAX_TIYIN: '200050000' });
      expect(found.join('\n')).toContain('TOPUP_MAX_TIYIN: must be a multiple of TOPUP_STEP_TIYIN');
    });

    it('refuses each daily cap that is not a multiple of the step', () => {
      const general = problems({ TOPUP_DAILY_MAX_TIYIN: '500050000' });
      expect(general.join('\n')).toContain('TOPUP_DAILY_MAX_TIYIN: must be a multiple of');
      const fresh = problems({ TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '50050000' });
      expect(fresh.join('\n')).toContain(
        'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: must be a multiple of',
      );
    });

    it('refuses a daily cap below the minimum request', () => {
      const fresh = problems({ TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '400000' });
      expect(fresh.join('\n')).toContain(
        'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: must not be below TOPUP_MIN_TIYIN',
      );
      const general = problems({
        TOPUP_DAILY_MAX_TIYIN: '400000',
        TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '400000',
      });
      expect(general.join('\n')).toContain(
        'TOPUP_DAILY_MAX_TIYIN: must not be below TOPUP_MIN_TIYIN',
      );
    });

    it('a cap equal to the minimum is fine', () => {
      expect(
        problems({
          TOPUP_DAILY_MAX_TIYIN: '500000',
          TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '500000',
        }),
      ).toEqual([]);
    });

    it('a zero step reports only the zero, not a division by zero', () => {
      const found = problems({ TOPUP_STEP_TIYIN: '0' });
      expect(found.join('\n')).toContain('TOPUP_STEP_TIYIN: must be greater than 0');
      expect(found.join('\n')).not.toContain('multiple');
    });

    it('accepts equal caps and a valid custom set', () => {
      expect(problems({ TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '500000000' })).toEqual([]);
      expect(
        problems({
          TOPUP_MIN_TIYIN: '1000000',
          TOPUP_MAX_TIYIN: '300000000',
          TOPUP_STEP_TIYIN: '500000',
          TOPUP_DAILY_MAX_TIYIN: '800000000',
          TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: '100000000',
        }),
      ).toEqual([]);
    });
  });

  describe('OWNER_ALERT_CHAT_ID', () => {
    it('accepts the numeric id of a user chat', () => {
      expect(buildTestEnv({ OWNER_ALERT_CHAT_ID: '555000' }).OWNER_ALERT_CHAT_ID).toBe('555000');
    });

    // tg-outbox writes to user chats only; a negative (group or channel) id would be accepted at
    // boot and then fail silently on the first alert, when the owner needs it most.
    it.each(['-100123456', '-1', 'abc', '12 3', '+5', '1.5', '0', '012', '1'.repeat(21)])(
      'refuses %j at boot',
      (bad) => {
        expect(messageOf({ ...TEST_ENV_SOURCE, OWNER_ALERT_CHAT_ID: bad })).toContain(
          'OWNER_ALERT_CHAT_ID',
        );
      },
    );
  });
});
