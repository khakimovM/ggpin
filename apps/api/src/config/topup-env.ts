import { TOPUP_BASE_UNIT_TIYIN } from '@repo/shared';

export interface TopupEnvLimits {
  readonly TOPUP_MIN_TIYIN: bigint;
  readonly TOPUP_MAX_TIYIN: bigint;
  readonly TOPUP_STEP_TIYIN: bigint;
  readonly TOPUP_DAILY_MAX_TIYIN: bigint;
  readonly TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: bigint;
}

export interface TopupEnvProblem {
  readonly name: keyof TopupEnvLimits;
  readonly message: string;
}

/**
 * Cross-field rules of the top-up limits, checked at boot. A limit that is 0, crosses another
 * one, or is not a multiple of the step would make every top-up fail, or let one through that
 * the owner meant to refuse; the database CHECK (`baseAmountTiyin % 100000 = 0`) would then
 * reject rows the API had already promised, so the step is tied to the same shared constant.
 */
export function topupEnvProblems(env: TopupEnvLimits): TopupEnvProblem[] {
  const problems: TopupEnvProblem[] = [];
  const problem = (name: keyof TopupEnvLimits, message: string): void => {
    problems.push({ name, message });
  };

  // The full Env object is passed in, so the five limits are listed by name (not enumerated).
  const all: (keyof TopupEnvLimits)[] = [
    'TOPUP_MIN_TIYIN',
    'TOPUP_MAX_TIYIN',
    'TOPUP_STEP_TIYIN',
    'TOPUP_DAILY_MAX_TIYIN',
    'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
  ];
  for (const name of all) {
    if (env[name] <= 0n) problem(name, 'must be greater than 0');
  }
  const step = env.TOPUP_STEP_TIYIN;
  if (step <= 0n) return problems; // every "multiple of the step" check below needs a step

  if (step % TOPUP_BASE_UNIT_TIYIN !== 0n) {
    problem(
      'TOPUP_STEP_TIYIN',
      `must be a multiple of ${TOPUP_BASE_UNIT_TIYIN} (the database CHECK)`,
    );
  }
  if (env.TOPUP_MIN_TIYIN > env.TOPUP_MAX_TIYIN) {
    problem('TOPUP_MIN_TIYIN', 'must not exceed TOPUP_MAX_TIYIN');
  }
  const multiples: (keyof TopupEnvLimits)[] = [
    'TOPUP_MIN_TIYIN',
    'TOPUP_MAX_TIYIN',
    'TOPUP_DAILY_MAX_TIYIN',
    'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
  ];
  for (const name of multiples) {
    if (env[name] % step !== 0n) problem(name, 'must be a multiple of TOPUP_STEP_TIYIN');
  }
  // A cap below the smallest request would refuse every top-up of that kind.
  for (const name of ['TOPUP_DAILY_MAX_TIYIN', 'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN'] as const) {
    if (env[name] < env.TOPUP_MIN_TIYIN) problem(name, 'must not be below TOPUP_MIN_TIYIN');
  }
  if (env.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN > env.TOPUP_DAILY_MAX_TIYIN) {
    problem(
      'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
      'must not exceed TOPUP_DAILY_MAX_TIYIN (a new account is limited more, not less)',
    );
  }
  return problems;
}
