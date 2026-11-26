import { placeholder } from '../adapters/fragment/fixture-sanitizer';
import { nameWordSet, plainText } from './fragment-record-plain';
import { readFound } from './fragment-record-read';
import type { RecordedStep } from './fragment-record-flow';
import type { StagedFixture } from './fragment-record-output';

// Strict text (P6-S0a fix rounds, CR F1/F3, SA F1/F2/F7): for an answer whose names the run
// cannot prove it knows in full, a string is staged only when it is plain (rule (b),
// fragment-record-plain.ts); anything else (a surname, a patronymic, a nickname, a name in another
// script or encoding) becomes `<REDACTED:secret>`. Keys that are not plain identifiers become
// `<REDACTED:key#N>`. Rule (a), `nameCovered`, decides when the owner's files need it.

const PLAIN_KEY = /^[a-z_][A-Za-z0-9_]{0,40}$/;
const SECRET = placeholder('secret');

export interface StrictOptions {
  /** Kept exactly as given (Fragment's pay addresses). */
  readonly keep: ReadonlySet<string>;
  /** A third person's answer: any run of 5+ digits (also split) is withheld too (SA F3, R2). */
  readonly digits: boolean;
}

/** True when the (already sanitized) string may be staged as it is: rule (b), or a keep value. */
export function plainValue(text: string, options: StrictOptions): boolean {
  return text === '' || options.keep.has(text) || plainText(text, options.digits);
}

export interface StrictResult {
  readonly value: unknown;
  /** How many strings and keys were withheld. */
  readonly withheld: number;
}

/** Applies strict text to a sanitized JSON value. */
export function strictJson(input: unknown, options: StrictOptions): StrictResult {
  let withheld = 0;
  let keyIndex = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (plainValue(value, options)) return value;
      withheld += 1;
      return SECRET;
    }
    if (typeof value === 'number') {
      return options.digits && Math.abs(value) >= 10_000 ? 0 : value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (PLAIN_KEY.test(k)) return [k, walk(v)];
          withheld += 1;
          keyIndex += 1;
          return [`<REDACTED:key#${keyIndex}>`, walk(v)];
        }),
      );
    }
    return value;
  };
  return { value: walk(input), withheld };
}

/** The staged fixture with its body under strict text; a page or text body becomes one secret. */
export function strictFixture(
  staged: StagedFixture,
  sanitizeJson: (value: unknown) => unknown,
  options: StrictOptions,
): { readonly staged: StagedFixture; readonly withheld: number } {
  const response = staged.value['response'];
  if (response === null || typeof response !== 'object') return { staged, withheld: 0 };
  const { body, bodyKind, ...rest } = response as Record<string, unknown>;
  const result =
    bodyKind === 'json'
      ? strictJson(sanitizeJson(body), options)
      : { value: SECRET, withheld: body === '' ? 0 : 1 };
  const value = {
    ...staged.value,
    response: { ...rest, bodyKind, strictText: true, body: result.value },
  };
  return { staged: { value, fullBodies: [] }, withheld: result.withheld };
}

/**
 * Rule (a): a `found.name` was read from one of `steps` and every word of it is among the given
 * names' words. Only then does the run know the whole display name it must redact.
 */
export function nameCovered(
  names: readonly string[],
  steps: readonly RecordedStep[],
  stepNames: readonly string[],
): boolean {
  const given = nameWordSet(names);
  if (given.size === 0) return false;
  const shown = steps
    .filter((s) => stepNames.includes(s.step))
    .map((s) => readFound(s.exchange.response.body)?.name ?? null)
    .filter((n): n is string => n !== null);
  if (shown.length === 0) return false;
  // A found.name with no word at all (emoji only, say) proves nothing (round 2): not covered.
  return shown.every((name) => {
    const words = [...nameWordSet([name])];
    return words.length > 0 && words.every((w) => given.has(w));
  });
}
