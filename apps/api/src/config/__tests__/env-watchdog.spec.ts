import { EnvValidationError } from '../env';
import { buildTestEnv } from './test-env';

describe('loadEnv: WORKER_DOWN_ALERT_AFTER_MS (phase 5 S6)', () => {
  it('defaults to two minutes', () => {
    expect(buildTestEnv().WORKER_DOWN_ALERT_AFTER_MS).toBe(120_000);
  });

  it('accepts 60000..3600000', () => {
    expect(buildTestEnv({ WORKER_DOWN_ALERT_AFTER_MS: '60000' }).WORKER_DOWN_ALERT_AFTER_MS).toBe(
      60_000,
    );
    expect(buildTestEnv({ WORKER_DOWN_ALERT_AFTER_MS: '3600000' }).WORKER_DOWN_ALERT_AFTER_MS).toBe(
      3_600_000,
    );
  });

  it.each(['59999', '3600001', '2.5', 'two'])('refuses %j', (value) => {
    expect(() => buildTestEnv({ WORKER_DOWN_ALERT_AFTER_MS: value })).toThrow(EnvValidationError);
  });
});
