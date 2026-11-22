import { randomUUID } from 'node:crypto';
import { adminConfirmationBinding, type AdminConfirmationBody } from '@repo/shared';
import { AppError } from '../../../../common/exceptions/app-error';
import type { RedisService } from '../../../../infra/redis/redis.service';
import { hashOtpCode } from '../../../auth/otp-code';
import { adminOtpNonce } from '../admin-otp.keys';
import { AdminOtpVerifier, type AdminOtpCheck } from '../admin-otp.verifier';

// The admin step-up code check (D-63 (4), D-65 D5) on a scripted Redis: the binding (body, flags,
// admin, session), the attempt count, single use and the one refusal for "wrong code" and "code
// for something else". The real Lua script and Redis are covered by the admin write e2e.
const PEPPER = 'p'.repeat(32);
const CHALLENGE = 'c'.repeat(32);
const CODE = '042170';
const BODY: AdminConfirmationBody = {
  action: 'users.adjustWallet',
  targetId: 'cm3user000000000000000001',
  amountTiyin: '500000',
  idempotencyKey: randomUUID(),
};
const CHECK: AdminOtpCheck = { body: BODY, serverFlags: [], adminId: 'adm1', sessionId: 'ses1' };

async function issued(check: AdminOtpCheck = CHECK) {
  const binding = await adminConfirmationBinding(check);
  return { binding, hash: hashOtpCode(PEPPER, adminOtpNonce(CHALLENGE, binding), CODE) };
}

function verifier(reply: unknown, deleted = 1) {
  const client = {
    eval: jest.fn().mockResolvedValue(reply),
    del: jest.fn().mockResolvedValue(deleted),
  };
  const redis = { client } as unknown as RedisService;
  return { client, otp: new AdminOtpVerifier(redis, { OTP_PEPPER: PEPPER }) };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return { code: error.code, details: error.details };
}

describe('AdminOtpVerifier', () => {
  it('the right code for the same binding passes once and deletes the challenge', async () => {
    const { binding, hash } = await issued();
    const { client, otp } = verifier([1, hash, binding]);
    await expect(
      otp.verify({ challengeId: CHALLENGE, code: CODE }, CHECK),
    ).resolves.toBeUndefined();
    expect(client.del).toHaveBeenCalledTimes(1);
  });

  it('another session, admin, flag or value: the same CODE_INVALID as a wrong code', async () => {
    const { binding, hash } = await issued();
    const others: AdminOtpCheck[] = [
      { ...CHECK, sessionId: 'ses2' },
      { ...CHECK, adminId: 'adm2' },
      { ...CHECK, serverFlags: ['override: none'] },
      { ...CHECK, body: { ...BODY, amountTiyin: '500001' } },
    ];
    for (const other of others) {
      const { client, otp } = verifier([2, hash, binding]);
      expect(await refusal(otp.verify({ challengeId: CHALLENGE, code: CODE }, other))).toEqual({
        code: 'CODE_INVALID',
        details: { attemptsLeft: 3 },
      });
      expect(client.del).not.toHaveBeenCalled();
    }
    const { otp } = verifier([2, hash, binding]);
    expect(await refusal(otp.verify({ challengeId: CHALLENGE, code: '999999' }, CHECK))).toEqual({
      code: 'CODE_INVALID',
      details: { attemptsLeft: 3 },
    });
  });

  it('no challenge, a bad id or a lost DEL race is CODE_EXPIRED; too many tries is OTP_LOCKED', async () => {
    const { binding, hash } = await issued();
    expect(
      (await refusal(verifier(null).otp.verify({ challengeId: CHALLENGE, code: CODE }, CHECK)))
        .code,
    ).toBe('CODE_EXPIRED');
    expect(
      (
        await refusal(
          verifier([1, hash, binding]).otp.verify({ challengeId: 'x', code: CODE }, CHECK),
        )
      ).code,
    ).toBe('CODE_EXPIRED');
    const raced = verifier([1, hash, binding], 0);
    expect(
      (await refusal(raced.otp.verify({ challengeId: CHALLENGE, code: CODE }, CHECK))).code,
    ).toBe('CODE_EXPIRED');
    const locked = await refusal(
      verifier([6, hash, binding]).otp.verify({ challengeId: CHALLENGE, code: CODE }, CHECK),
    );
    expect(locked.details).toEqual({ field: 'otp', reason: 'OTP_LOCKED' });
  });
});
