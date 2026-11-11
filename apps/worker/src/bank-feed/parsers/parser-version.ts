/**
 * Stored on every `BankMessage` row (parsed or not), so a re-parse during review or
 * reconciliation can tell which rules produced the stored fields.
 *
 * Still 1 although the rules changed during phase 4 review: no row has been written yet. After
 * production starts, bump it on every rule change that could turn the same text into a
 * different result.
 */
export const PARSER_VERSION = 1;
