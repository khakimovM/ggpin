// Request/response shapes of docs/04-API-CONTRACT.md "Auth" and "/me", as approved by the
// owner (phase 2, Q2/Q3/Q13). These describe the `data` payload; the envelope is in the API.
// Requests are `.strict()` (.claude/rules/60-security.md); responses carry ISO date strings
// and money-free, string-typed ids (telegramId is a BigInt in the DB, a string on the wire).
import { z } from 'zod';
import { LOCALES } from './locale';
import { LOGIN_NONCE_PATTERN } from './start-payload';

export const INIT_DATA_MAX_LENGTH = 4096;

export const localeSchema = z.enum(LOCALES);

const nonceSchema = z.string().regex(LOGIN_NONCE_PATTERN);
const isoDateSchema = z.iso.datetime();

// ---- /me --------------------------------------------------------------------------------
export const meSchema = z.object({
  id: z.string().min(1),
  telegramId: z.string().regex(/^\d{1,19}$/),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  locale: localeSchema,
  referralCode: z.string().min(1),
  phoneLinked: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const updateMeBodySchema = z.strictObject({ locale: localeSchema });
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

// ---- Mini App ---------------------------------------------------------------------------
export const webAppLoginBodySchema = z.strictObject({
  initData: z.string().min(1).max(INIT_DATA_MAX_LENGTH),
});
export type WebAppLoginBody = z.infer<typeof webAppLoginBodySchema>;

export const webAppLoginResponseSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.number().int().positive(), // seconds
  user: meSchema,
});
export type WebAppLoginResponse = z.infer<typeof webAppLoginResponseSchema>;

// ---- Web login through the bot (OTP) ------------------------------------------------------
export const loginStartBodySchema = z.strictObject({});
export type LoginStartBody = z.infer<typeof loginStartBodySchema>;

export const loginStartResponseSchema = z.object({
  nonce: nonceSchema,
  botUrl: z.string().regex(/^https:\/\/t\.me\/[A-Za-z0-9_]{1,32}\?start=login_[A-Za-z0-9_-]{43}$/),
});
export type LoginStartResponse = z.infer<typeof loginStartResponseSchema>;

export const loginStatusParamsSchema = z.strictObject({ nonce: nonceSchema });
export type LoginStatusParams = z.infer<typeof loginStatusParamsSchema>;

// The DB also has USED; it is reported as EXPIRED so a consumed nonce reveals nothing (Q3).
export const LOGIN_STATUSES = ['PENDING', 'CODE_SENT', 'DENIED', 'EXPIRED'] as const;
export const loginStatusResponseSchema = z.object({ status: z.enum(LOGIN_STATUSES) });
export type LoginStatusResponse = z.infer<typeof loginStatusResponseSchema>;

export const loginVerifyBodySchema = z.strictObject({
  nonce: nonceSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type LoginVerifyBody = z.infer<typeof loginVerifyBodySchema>;

// verify and refresh set the cookies and return the user.
export const sessionUserResponseSchema = z.object({ user: meSchema });
export type SessionUserResponse = z.infer<typeof sessionUserResponseSchema>;

export const logoutResponseSchema = z.strictObject({});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

// ---- Sessions ----------------------------------------------------------------------------
export const sessionItemSchema = z.object({
  id: z.string().min(1), // the session family id, not a single refresh-token row
  userAgent: z.string().nullable(),
  ipMasked: z.string().nullable(), // the raw IP is PII and never leaves the API
  createdAt: isoDateSchema,
  lastUsedAt: isoDateSchema,
  current: z.boolean(),
});
export type SessionItem = z.infer<typeof sessionItemSchema>;

export const sessionsResponseSchema = z.array(sessionItemSchema);
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
