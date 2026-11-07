import { randomInt } from 'node:crypto';
import type { AppError } from '../../common/exceptions/app-error';
import { CARD_BANKS, shortHolderName, type CardBank } from '@repo/shared';
import {
  checkedId,
  checkedIp,
  checkedOperator,
  checkedOsUser,
  checkedReason,
  INVISIBLE,
  MAX_BIGINT_TIYIN,
  validationError,
} from '../../common/admin/admin-input';

// Input checks of the owner-CLI card services. The CLI is the only caller (no HTTP route), but
// a typo here would put a wrong card in front of customers, so every field is checked and a
// refusal names the field, never the value (a PAN must not end up in a terminal log either).
// The checks every owner-CLI service shares live in common/admin/admin-input.ts.

export { checkedReason };

export function cardInputError(field: string, reason?: string): AppError {
  return validationError(field, reason);
}

/** Who ran the CLI command: an operator name and, when known, the SSH client and OS account. */
export interface CardAdminActor {
  readonly operator: string;
  readonly ip?: string | null;
  /** The OS login (and the sudo caller), AuditLog.after.osUser (S8-L5). */
  readonly osUser?: string | null;
}

export interface CheckedActor {
  readonly operator: string;
  readonly ip: string | null;
  readonly osUser: string | null;
}

const HOLDER_MAX = 64;

export function checkedActor(actor: CardAdminActor): CheckedActor {
  return {
    operator: checkedOperator(actor.operator),
    ip: checkedIp(actor.ip),
    osUser: checkedOsUser(actor.osUser),
  };
}

/** The "who" fields every CLI AuditLog.after carries. */
export function actorAfter(actor: CheckedActor): { operator: string; osUser: string | null } {
  return { operator: actor.operator, osUser: actor.osUser };
}

export function checkedCardId(id: string): string {
  return checkedId('cardId', id);
}

export function checkedBank(bank: string): CardBank {
  const found = CARD_BANKS.find((candidate) => candidate === bank);
  if (found === undefined) throw cardInputError('bank');
  return found;
}

/** The Luhn check digit of ISO/IEC 7812 card numbers (catches one wrong or two swapped digits). */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** 16 digits (spaces and dashes as typed are dropped), Luhn-valid. */
export function checkedPan(pan: string): string {
  const digits = pan.replace(/[\s-]/g, '');
  if (!/^\d{16}$/.test(digits) || !luhnValid(digits)) throw cardInputError('pan');
  return digits;
}

/** Holder name as printed on the card: single spaces, visible, and a non-empty short form. */
export function checkedHolderName(name: string): string {
  const normalised = name.trim().replace(/\s+/g, ' ');
  if (
    normalised.length < 1 ||
    normalised.length > HOLDER_MAX ||
    INVISIBLE.test(normalised) ||
    shortHolderName(normalised) === ''
  ) {
    throw cardInputError('holderName');
  }
  return normalised;
}

export function checkedLimit(field: string, value: bigint): bigint {
  if (value <= 0n || value > MAX_BIGINT_TIYIN) throw cardInputError(field);
  return value;
}

/** The test transfer that verifies a new card: 1 000 so'm + 1..999 so'm (docs/05 §2). */
export function newVerifyAmountTiyin(random: (n: number) => number = randomInt): bigint {
  return 100_000n + BigInt(1 + random(999)) * 100n;
}
