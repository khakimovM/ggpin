import { EnvValidationError, loadEnv } from '../env';
import { TEST_ENV_SOURCE, TEST_OTP_PEPPER, TEST_PAY_TOKEN_PEPPER, buildTestEnv } from './test-env';

function messageOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv: P2P top-up tuning and the pay-link pepper (phase 4)', () => {
  it('has the documented defaults: suffix 1..999 so‘m, 30 min TTL, 24 h grace, 7-day new account, 120 s heartbeat', () => {
    const env = buildTestEnv();
    expect(env.TOPUP_SUFFIX_MAX_SOM).toBe(999);
    expect(env.TOPUP_INTENT_TTL_SEC).toBe(1800);
    expect(env.TOPUP_LATE_GRACE_SEC).toBe(86_400);
    expect(env.TOPUP_NEW_ACCOUNT_AGE_SEC).toBe(604_800);
    expect(env.BANK_FEED_HEARTBEAT_MAX_AGE_SEC).toBe(120);
    expect(env.TOPUP_CAPACITY_HOLD_SEC).toBe(3_600);
  });

  it.each([
    ['TOPUP_SUFFIX_MAX_SOM', '0'],
    ['TOPUP_SUFFIX_MAX_SOM', '1000'],
    ['TOPUP_SUFFIX_MAX_SOM', '1.5'],
    ['TOPUP_INTENT_TTL_SEC', '59'],
    ['TOPUP_INTENT_TTL_SEC', '86401'],
    // A grace below an hour would let an amount be reissued while a slow transfer is in flight.
    ['TOPUP_LATE_GRACE_SEC', '3599'],
    ['TOPUP_LATE_GRACE_SEC', '604801'],
    ['TOPUP_NEW_ACCOUNT_AGE_SEC', '-1'],
    ['BANK_FEED_HEARTBEAT_MAX_AGE_SEC', '9'],
    ['BANK_FEED_HEARTBEAT_MAX_AGE_SEC', 'abc'],
    ['TOPUP_CAPACITY_HOLD_SEC', '0'],
    ['TOPUP_CAPACITY_HOLD_SEC', '-5'],
  ])('refuses %s=%s', (name, value) => {
    expect(messageOf({ ...TEST_ENV_SOURCE, [name]: value })).toContain(name);
  });

  it('accepts a small suffix range (used by the exhaustion tests)', () => {
    expect(buildTestEnv({ TOPUP_SUFFIX_MAX_SOM: '3' }).TOPUP_SUFFIX_MAX_SOM).toBe(3);
  });

  describe('grace and capacity hold (D-37 (2), D-42 (1))', () => {
    const graceProblem = 'TOPUP_LATE_GRACE_SEC: must be at least 86400 in production';

    it('production refuses a grace under 24 h; at 24 h it has nothing to say about it', () => {
      const prod = { ...TEST_ENV_SOURCE, NODE_ENV: 'production' };
      expect(
        messageOf({ ...prod, TOPUP_LATE_GRACE_SEC: '86399', TOPUP_CAPACITY_HOLD_SEC: '60' }),
      ).toContain(graceProblem);
      // Production needs more settings than the test source has, so loadEnv still throws: the
      // point is only that the grace is not among the complaints.
      expect(messageOf({ ...prod, TOPUP_LATE_GRACE_SEC: '86400' })).not.toContain(
        'TOPUP_LATE_GRACE_SEC',
      );
    });

    it('production: the hold is at least the request lifetime (R-5); dev and test may go lower', () => {
      const prod = { ...TEST_ENV_SOURCE, NODE_ENV: 'production', TOPUP_INTENT_TTL_SEC: '1800' };
      const holdProblem = 'TOPUP_CAPACITY_HOLD_SEC: must be at least TOPUP_INTENT_TTL_SEC';
      expect(messageOf({ ...prod, TOPUP_CAPACITY_HOLD_SEC: '1799' })).toContain(holdProblem);
      expect(messageOf({ ...prod, TOPUP_CAPACITY_HOLD_SEC: '1800' })).not.toContain(holdProblem);
      expect(buildTestEnv({ TOPUP_CAPACITY_HOLD_SEC: '60' }).TOPUP_CAPACITY_HOLD_SEC).toBe(60);
    });

    it('dev and test keep the 1 h minimum', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const env = buildTestEnv({ NODE_ENV, TOPUP_LATE_GRACE_SEC: '3600' });
        expect(env.TOPUP_LATE_GRACE_SEC).toBe(3_600);
      }
    });

    it('the hold may equal the grace but never exceed it', () => {
      const equal = buildTestEnv({ TOPUP_LATE_GRACE_SEC: '7200', TOPUP_CAPACITY_HOLD_SEC: '7200' });
      expect(equal.TOPUP_CAPACITY_HOLD_SEC).toBe(7_200);
      expect(
        messageOf({
          ...TEST_ENV_SOURCE,
          TOPUP_LATE_GRACE_SEC: '7200',
          TOPUP_CAPACITY_HOLD_SEC: '7201',
        }),
      ).toContain('TOPUP_CAPACITY_HOLD_SEC: must not exceed TOPUP_LATE_GRACE_SEC');
    });
  });

  describe('PAY_TOKEN_PEPPER', () => {
    it('is required: the API does not boot without it', () => {
      const { PAY_TOKEN_PEPPER: _removed, ...without } = TEST_ENV_SOURCE;
      expect(messageOf(without)).toContain('PAY_TOKEN_PEPPER: is required but not set');
    });

    it('must differ from every other signing secret, without echoing the value', () => {
      const message = messageOf({ ...TEST_ENV_SOURCE, PAY_TOKEN_PEPPER: TEST_OTP_PEPPER });
      expect(message).toContain('PAY_TOKEN_PEPPER: must differ from OTP_PEPPER');
      expect(message).not.toContain(TEST_OTP_PEPPER);
    });

    it('refuses the .env.example placeholder in every NODE_ENV', () => {
      const message = messageOf({
        ...TEST_ENV_SOURCE,
        PAY_TOKEN_PEPPER: 'change-me-pay-token-pepper-min-32-chars',
      });
      expect(message).toContain('PAY_TOKEN_PEPPER: is a placeholder');
    });

    it('the test value loads as is', () => {
      expect(buildTestEnv().PAY_TOKEN_PEPPER).toBe(TEST_PAY_TOKEN_PEPPER);
    });
  });
});
