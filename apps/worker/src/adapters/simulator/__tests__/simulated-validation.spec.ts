import { RECIPIENT_CHECK_TIMEOUT_MS, RecipientCheckResultSchema } from '@repo/shared';
import { SimulatedFragmentAdapter } from '../simulated-fragment.adapter';
import { SimulatedResellerAdapter } from '../simulated-reseller.adapter';
import {
  SIM_SCENARIOS,
  SIM_SLOW_CHECK_MS,
  SimulatorScript,
  simulatedProviderRef,
  simulatedRecipientProblem,
  simulatedValidation,
} from '../simulator-script';

// The simulated `validateRecipient` (phase 5 S3b): under OK it answers by the username's shape,
// always on the normalized username, and agrees with the `prepare` re-check, so a dry-run order
// validated as FOUND is never refunded as RECIPIENT_CHANGED.

const DRY = { NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true };
const product = { id: 'p1', slug: 'stars' };

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('simulatedValidation: username shapes (scenario OK)', () => {
  it('a plain username is FOUND as sim_<normalized>, whatever its spelling', async () => {
    for (const raw of ['aziz_k', '@Aziz_K', '  @AZIZ_K ']) {
      const result = await simulatedValidation('OK', { username: raw });
      expect(result).toEqual({ status: 'FOUND', providerRef: 'sim_aziz_k', displayName: 'aziz_k' });
      expect(RecipientCheckResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('notfound_* is NOT_FOUND (also spelled with @ and capitals)', async () => {
    await expect(simulatedValidation('OK', { username: 'notfound_bob' })).resolves.toEqual({
      status: 'NOT_FOUND',
    });
    await expect(simulatedValidation('OK', { username: '@NotFound_Bob' })).resolves.toEqual({
      status: 'NOT_FOUND',
    });
  });

  it('no username field (or a blank one) is a malformed question: UNAVAILABLE in every scenario', async () => {
    const inputs: Readonly<Record<string, string>>[] = [
      {},
      { username: '' },
      { username: '   ' },
      { playerId: 'alice' },
    ];
    for (const scenario of SIM_SCENARIOS) {
      for (const input of inputs) {
        await expect(simulatedValidation(scenario, input)).resolves.toEqual({
          status: 'UNAVAILABLE',
        });
        // And never a payable recipient at prepare time either.
        const recipient = { fields: input, providerRef: 'sim_alice' };
        expect(simulatedRecipientProblem(scenario, recipient)).toBe('RECIPIENT_GONE');
      }
    }
  });

  it('a value that cannot be a Telegram username is NOT_FOUND (nobody has that name)', async () => {
    for (const username of ['ab', '1abcdef', 'x']) {
      await expect(simulatedValidation('OK', { username })).resolves.toEqual({
        status: 'NOT_FOUND',
      });
    }
  });

  it('slowcheck_* answers only after SIM_SLOW_CHECK_MS (longer than the API waits): UNAVAILABLE', async () => {
    expect(SIM_SLOW_CHECK_MS).toBeGreaterThan(RECIPIENT_CHECK_TIMEOUT_MS);
    jest.useFakeTimers();
    let settled: unknown;
    void simulatedValidation('OK', { username: '@SlowCheck_X' }).then((r) => {
      settled = r;
    });
    await jest.advanceTimersByTimeAsync(SIM_SLOW_CHECK_MS - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ status: 'UNAVAILABLE' });
  });

  it('the slowcheck timer is unref: it never keeps a process (or a test) alive', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    void simulatedValidation('OK', { username: 'slowcheck_y' });
    await Promise.resolve();
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    expect(timer?.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});

describe('simulatedValidation: scenarios keep their behaviour', () => {
  it('NOT_FOUND / UNKNOWN / TIMEOUT', async () => {
    const input = { username: 'alice' };
    await expect(simulatedValidation('NOT_FOUND', input)).resolves.toEqual({
      status: 'NOT_FOUND',
    });
    await expect(simulatedValidation('UNKNOWN', input)).resolves.toEqual({ status: 'UNAVAILABLE' });
    await expect(simulatedValidation('TIMEOUT', input)).resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('PRICE_UP / NOT_SENT are prepare-time scenarios: validation still FOUND', async () => {
    for (const scenario of ['PRICE_UP', 'NOT_SENT'] as const) {
      await expect(simulatedValidation(scenario, { username: 'alice' })).resolves.toEqual({
        status: 'FOUND',
        providerRef: simulatedProviderRef('alice'),
        displayName: 'alice',
      });
    }
  });

  it('both simulators answer through it (default scenario of the script)', async () => {
    const script = new SimulatorScript();
    const adapters = [
      new SimulatedFragmentAdapter(DRY, script),
      new SimulatedResellerAdapter(DRY, script),
    ];
    for (const adapter of adapters) {
      await expect(adapter.validateRecipient(product, { username: '@Aziz_K' })).resolves.toEqual(
        expect.objectContaining({ status: 'FOUND', providerRef: 'sim_aziz_k' }),
      );
      await expect(
        adapter.validateRecipient(product, { username: 'notfound_q1' }),
      ).resolves.toEqual({ status: 'NOT_FOUND' });
    }
  });
});

describe('validation and the prepare re-check agree (no RECIPIENT_CHANGED in a dry run)', () => {
  const usernames = ['aziz_k', '@Aziz_K', 'user12345', 'slowcheck_a', 'notfound_b', 'x'];

  it.each(SIM_SCENARIOS)('scenario %s: FOUND -> re-check null; otherwise never null', async (s) => {
    for (const raw of usernames) {
      const result = await Promise.race([
        simulatedValidation(s, { username: raw }),
        Promise.resolve({ status: 'PENDING' } as const),
      ]);
      if (result.status === 'FOUND') {
        // The order stores the normalized username (S3a) or, defensively, the raw spelling.
        for (const stored of [result.displayName, raw]) {
          const recipient = { fields: { username: stored }, providerRef: result.providerRef };
          expect(simulatedRecipientProblem(s, recipient)).toBeNull();
        }
      } else if (result.status === 'NOT_FOUND') {
        const recipient = { fields: { username: raw }, providerRef: simulatedProviderRef('zzzzz') };
        expect(simulatedRecipientProblem(s, recipient)).not.toBeNull();
      }
    }
  });

  it('notfound_* is gone at prepare too, even with its sim_ handle', () => {
    const recipient = { fields: { username: 'notfound_b' }, providerRef: 'sim_notfound_b' };
    expect(simulatedRecipientProblem('OK', recipient)).toBe('RECIPIENT_GONE');
  });
});
