import { createHash } from 'node:crypto';

// Redis keys and the outbox job id of an admin step-up code (D-63 (4)). Redis and the outbox see
// a digest of the challenge id, never the id the browser holds (the owner CLI's rule, D-46).
function handle(challengeId: string): string {
  return createHash('sha256').update(challengeId).digest('hex').slice(0, 32);
}

export const adminOtpKey = (challengeId: string): string => `admin-otp:${handle(challengeId)}`;

/** The tg-outbox job id of the code's message (no ':' — BullMQ refuses it). */
export const adminOtpJobId = (challengeId: string): string => `admin-otp-${handle(challengeId)}`;

/** Codes issued to one admin on one Asia/Tashkent day (`ADMIN_OTP_DAILY_MAX`). */
export const adminOtpQuotaKey = (adminId: string, tashkentDay: string): string =>
  `admin-otp-daily:${adminId}:${tashkentDay}`;

/** The HMAC nonce: a hash made for one challenge AND one binding is useless for any other. */
export const adminOtpNonce = (challengeId: string, binding: string): string =>
  `admin|${challengeId}|${binding}`;
