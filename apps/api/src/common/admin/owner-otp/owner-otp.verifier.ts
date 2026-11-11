import { Inject, Injectable, Logger } from '@nestjs/common';
import { OTP_LENGTH, OTP_MAX_ATTEMPTS } from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { otpCodeMatches } from '../../../modules/auth/otp-code';
import { validationError } from '../admin-input';
import {
  CHALLENGE_ID_PATTERN,
  otpBinding,
  otpNonce,
  ownerOtpKey,
  type OtpAnswer,
  type OwnerOtpAction,
  type OwnerOtpScope,
} from './owner-otp';

// One atomic step: no challenge -> nil; otherwise count this attempt FIRST (HINCRBY) and return
// the count with the stored hash and binding. Counting before comparing means a burst of guesses
// in parallel still spends one attempt each. A missing key is never created (no TTL-less key).
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return {n, redis.call('HGET', KEYS[1], 'hash'), redis.call('HGET', KEYS[1], 'binding')}
`;

const CODE_PATTERN = new RegExp(`^\\d{${String(OTP_LENGTH)}}$`);

/**
 * Checks the owner's code inside the money services (D-46), before their transaction. Refusals
 * (`VALIDATION_ERROR`, field `otp`): OTP_EXPIRED (unknown, expired or already used), OTP_LOCKED
 * (more than OTP_MAX_ATTEMPTS tries), OTP_MISMATCH (issued for another action, amount or
 * target or flags), OTP_INVALID (wrong code). Success deletes the challenge: a code works once.
 * A wrong, locked or mismatched code is a security event (S8 R1-I4, R2-I2): a warn line with
 * the action and the result only, never the code, the challenge or the binding.
 */
@Injectable()
export class OwnerOtpVerifier {
  private readonly logger = new Logger('OwnerOtp');

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * False when no code was given (the caller then refuses above the threshold); true once a
   * given code is verified. A code needs the re-typed amount: it is what the code is bound to.
   */
  async verifyIfGiven(
    otp: OtpAnswer | undefined,
    confirmAmountTiyin: bigint | undefined,
    action: OwnerOtpAction,
    target: string,
    flags = '',
  ): Promise<boolean> {
    if (otp === undefined) return false;
    if (confirmAmountTiyin === undefined) throw validationError('confirmAmountTiyin');
    await this.verify(otp, { action, amountTiyin: confirmAmountTiyin, target, flags });
    return true;
  }

  async verify(otp: OtpAnswer, scope: OwnerOtpScope): Promise<void> {
    if (!CHALLENGE_ID_PATTERN.test(otp.challengeId)) throw validationError('otp', 'OTP_EXPIRED');
    const key = ownerOtpKey(otp.challengeId);
    const raw: unknown = await this.redis.client.eval(ATTEMPT_SCRIPT, 1, key);
    if (!Array.isArray(raw)) throw validationError('otp', 'OTP_EXPIRED');
    const [attempts, hash, binding] = raw as unknown[];
    if (typeof attempts !== 'number' || typeof hash !== 'string' || typeof binding !== 'string') {
      throw validationError('otp', 'OTP_EXPIRED');
    }
    if (attempts > OTP_MAX_ATTEMPTS) throw this.refused(scope, 'OTP_LOCKED');
    const expected = otpBinding(scope);
    if (binding !== expected) throw this.refused(scope, 'OTP_MISMATCH');
    const nonce = otpNonce(otp.challengeId, binding);
    if (
      !CODE_PATTERN.test(otp.code) ||
      !otpCodeMatches(this.config.OTP_PEPPER, nonce, otp.code, hash)
    ) {
      throw this.refused(scope, 'OTP_INVALID');
    }
    // Single use: only the caller whose DEL removed the challenge may go on.
    if ((await this.redis.client.del(key)) !== 1) throw validationError('otp', 'OTP_EXPIRED');
  }

  private refused(scope: OwnerOtpScope, result: 'OTP_INVALID' | 'OTP_LOCKED' | 'OTP_MISMATCH') {
    this.logger.warn(`security: owner code refused action=${scope.action} result=${result}`);
    return validationError('otp', result);
  }
}
