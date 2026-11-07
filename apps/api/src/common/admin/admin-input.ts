import { isIP } from 'node:net';
import { ResourceIdSchema } from '@repo/shared';
import { AppError } from '../exceptions/app-error';

// Input checks shared by every owner-CLI service (wallet money actions, receiving cards). The
// CLI is the only caller (no HTTP route), but what it writes lands in the audit trail and in
// front of customers, so every field is checked and a refusal names the field, never the value
// (a PAN or an amount must not end up in a terminal log either).

export const REASON_MAX_LENGTH = 500;
export const OPERATOR_MAX_LENGTH = 64;
/** BIGINT column bound: a bigger amount would otherwise surface as a database error. */
export const MAX_BIGINT_TIYIN = 9_223_372_036_854_775_807n;

/** `400 VALIDATION_ERROR` naming the field (and, for some refusals, why). */
export function validationError(field: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', { field, ...(reason === undefined ? {} : { reason }) });
}

// Control (Cc) and format (Cf: zero-width space, bidi overrides) characters, and line/paragraph
// separators: none is visible, and a bidi override can make an audit line read differently from
// what was typed. A reason also needs a letter or digit, so "...", "-" or blanks cannot pass.
export const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The trimmed reason: 1..500 characters, visible text with at least one letter or digit. */
export function checkedReason(reason: string): string {
  const trimmed = reason.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > REASON_MAX_LENGTH ||
    INVISIBLE.test(trimmed) ||
    !HAS_LETTER_OR_DIGIT.test(trimmed)
  ) {
    throw validationError('reason');
  }
  return trimmed;
}

// Words of visible characters (letters, digits, punctuation, symbols) joined by single spaces:
// no leading, trailing or doubled blanks, no tabs, no invisible characters.
const OPERATOR_SHAPE = /^[\p{L}\p{N}\p{P}\p{S}]+(?: [\p{L}\p{N}\p{P}\p{S}]+)*$/u;

/** The CLI operator's name, stored in AuditLog.after.operator (the actor type is CLI, not a user). */
export function checkedOperator(operator: string): string {
  if (operator.length > OPERATOR_MAX_LENGTH || !OPERATOR_SHAPE.test(operator)) {
    throw validationError('operator');
  }
  return operator;
}

/** An IPv4/IPv6 literal or nothing; the CLI passes the SSH client address when it has one. */
export function checkedIp(ip: string | null | undefined): string | null {
  if (ip === undefined || ip === null) return null;
  if (isIP(ip) === 0) throw validationError('ip');
  return ip;
}

export function checkedId(field: string, value: string): string {
  if (!ResourceIdSchema.safeParse(value).success) throw validationError(field);
  return value;
}

export const OS_USER_MAX_LENGTH = 128;
// A login name, optionally "name (sudo from other)": letters, digits, . _ - $ ( ) and single
// spaces; nothing invisible.
const OS_USER_SHAPE = /^[\p{L}\p{N}._$()-]+(?: [\p{L}\p{N}._$()-]+)*$/u;

/** The OS account that ran the CLI (AuditLog.after.osUser); null when the CLI could not tell. */
export function checkedOsUser(osUser: string | null | undefined): string | null {
  if (osUser === undefined || osUser === null) return null;
  if (osUser.length > OS_USER_MAX_LENGTH || !OS_USER_SHAPE.test(osUser)) {
    throw validationError('osUser');
  }
  return osUser;
}
