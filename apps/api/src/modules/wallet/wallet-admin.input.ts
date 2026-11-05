import { isIP } from 'node:net';
import { ResourceIdSchema } from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';

export const REASON_MAX_LENGTH = 500;
// BIGINT column bound; a bigger amount would otherwise surface as a database error.
const MAX_AMOUNT_TIYIN = 9_223_372_036_854_775_807n;

export function validationError(field: string): AppError {
  return new AppError('VALIDATION_ERROR', { field });
}

// Control (Cc) and format (Cf: zero-width space, bidi overrides) characters, and line/paragraph
// separators: none is visible, and a bidi override can make an audit line read differently from
// what was typed. A reason also needs a letter or digit, so "...", "-" or blanks cannot pass.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
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

export const OPERATOR_MAX_LENGTH = 64;
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

export function checkedAdjustAmount(amountTiyin: bigint): bigint {
  if (amountTiyin === 0n || amountTiyin > MAX_AMOUNT_TIYIN || amountTiyin < -MAX_AMOUNT_TIYIN) {
    throw validationError('amountTiyin');
  }
  return amountTiyin;
}

export function checkedId(field: string, value: string): string {
  if (!ResourceIdSchema.safeParse(value).success) throw validationError(field);
  return value;
}

/**
 * Above the threshold the operator must retype the exact amount (the CLI asks for it): a typo in
 * a large number is caught before money moves. Equal to the threshold needs no confirmation.
 */
export function requireConfirmation(
  amountTiyin: bigint,
  confirmAmountTiyin: bigint | undefined,
  thresholdTiyin: bigint,
): void {
  const magnitude = amountTiyin < 0n ? -amountTiyin : amountTiyin;
  if (magnitude <= thresholdTiyin) return;
  if (confirmAmountTiyin !== amountTiyin) throw validationError('confirmAmountTiyin');
}
