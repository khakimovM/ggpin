import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  adminConfirmationBinding,
  type AdminConfirmationBody,
  type AdminOtpAnswer,
} from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { validationError } from '../../../common/admin/admin-input';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { RedisService } from '../../../infra/redis/redis.service';
import { otpCodeMatches } from '../../auth/otp-code';
import { adminOtpKey, adminOtpNonce } from './admin-otp.keys';

// One atomic step (the owner CLI's script): no challenge -> nil; otherwise count this attempt
// FIRST and return the count with the stored hash and binding. A missing key is never created.
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return {n, redis.call('HGET', KEYS[1], 'hash'), redis.call('HGET', KEYS[1], 'binding')}
`;

const CODE_PATTERN = new RegExp(`^[0-9]{${String(OTP_LENGTH)}}$`);
const CHALLENGE_ID = /^[0-9a-f]{32}$/;

export interface AdminOtpCheck {
  /** The confirmation body the action rebuilt from its own request (docs/04 binding). */
  readonly body: AdminConfirmationBody;
  /** What the service computed under its own reads; never from the client. */
  readonly serverFlags: readonly string[];
  readonly adminId: string;
  readonly sessionId: string;
}

/**
 * Checks an admin's step-up code (D-63 (4), docs/04 «Tasdiq kodi»), before the action's
 * transaction. The binding covers the whole body, the server flags, the admin AND the session:
 * a code is worthless in another session, for another admin or for any other value. Answers in
 * the admin vocabulary directly (D-65 D5): a wrong code and a code for another binding are the
 * same `422 CODE_INVALID` + `attemptsLeft` (no oracle); unknown, expired or used → `422
 * CODE_EXPIRED`; more than OTP_MAX_ATTEMPTS tries → `400 otp OTP_LOCKED`. Success deletes the
 * challenge: one code, one use.
 */
@Injectable()
export class AdminOtpVerifier {
  private readonly logger = new Logger('AdminOtp');

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'OTP_PEPPER'>,
  ) {}

  async verify(otp: AdminOtpAnswer, check: AdminOtpCheck): Promise<void> {
    if (!CHALLENGE_ID.test(otp.challengeId)) throw new AppError('CODE_EXPIRED');
    const key = adminOtpKey(otp.challengeId);
    const raw: unknown = await this.redis.client.eval(ATTEMPT_SCRIPT, 1, key);
    if (!Array.isArray(raw)) throw new AppError('CODE_EXPIRED');
    const [attempts, hash, stored] = raw as unknown[];
    if (typeof attempts !== 'number' || typeof hash !== 'string' || typeof stored !== 'string') {
      throw new AppError('CODE_EXPIRED');
    }
    if (attempts > OTP_MAX_ATTEMPTS) {
      this.warn(check, 'OTP_LOCKED');
      throw validationError('otp', 'OTP_LOCKED');
    }
    const binding = await adminConfirmationBinding(check);
    const attemptsLeft = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
    // SECURITY: the binding compared first, the code only for the right binding; both refusals
    // are the same answer.
    if (
      stored !== binding ||
      !CODE_PATTERN.test(otp.code) ||
      !otpCodeMatches(
        this.config.OTP_PEPPER,
        adminOtpNonce(otp.challengeId, binding),
        otp.code,
        hash,
      )
    ) {
      this.warn(check, stored !== binding ? 'OTP_MISMATCH' : 'OTP_INVALID');
      throw new AppError('CODE_INVALID', { attemptsLeft });
    }
    // Single use: only the caller whose DEL removed the challenge may go on.
    if ((await this.redis.client.del(key)) !== 1) throw new AppError('CODE_EXPIRED');
  }

  // A refused code is a security event: the action and the result only, never the code, the
  // challenge or the binding.
  private warn(check: AdminOtpCheck, result: string): void {
    this.logger.warn(
      `security: admin code refused action=${check.body.action} admin=${check.adminId} result=${result}`,
    );
  }
}
