import type { ParseFailureReason, UnrecognizedBankMessage } from '@repo/shared';

// The result vocabulary lives in @repo/shared (the reason codes are stored, alerted and listed
// in docs/05 §5); re-exported so the parser modules keep one local import.
export {
  PARSE_FAILURE_REASONS,
  type BankParseResult,
  type ParseFailureReason,
  type ParsedBankMessage,
  type UnrecognizedBankMessage,
} from '@repo/shared';

export function unrecognized(reason: ParseFailureReason): UnrecognizedBankMessage {
  return { ok: false, reason };
}
