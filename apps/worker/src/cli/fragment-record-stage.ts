import type { FixtureSanitizer } from '../adapters/fragment/fixture-sanitizer';
import { namePresence } from '../adapters/fragment/name-presence';
import type { FlowResult, RecordedStep, StepName } from './fragment-record-flow';
import { fixtureOf, type StagedFixture } from './fragment-record-output';
import { nameCovered, strictFixture } from './fragment-record-strict';

// What the recorder stages, and why it holds something back (plan S0b fix rounds, P6-S0a). Lines
// returned here name steps, files and option numbers only: never a value.

/**
 * Why nothing may be staged for the --name values (F-5, M-1), or null: no answer shows any of
 * them, or one is only partly shown (a typo or another transliteration). Never names a value.
 */
export function nameProblem(
  names: readonly string[],
  steps: readonly RecordedStep[],
): string | null {
  if (names.length === 0) return null;
  const presence = namePresence(
    names,
    steps.map((s) => s.exchange.response.body),
  );
  if (presence.every((p) => p.found === 0)) return 'name not found in responses (check --name)';
  const partly = presence.findIndex((p) => p.found > 0 && p.found < p.total);
  return partly === -1 ? null : `name ${partly + 1} partly found (check --name)`;
}

export const HOLDER_STEP: StepName = 'search-premium-holder';

/** The owner's own searches: where rule (a) reads the owner's `found.name`. */
export const OWNER_SEARCH_STEPS: readonly StepName[] = [
  'search-stars-recipient',
  'search-premium-recipient',
];

export type HolderCheck =
  | { readonly state: 'not-searched' }
  | { readonly state: 'partly'; readonly index: number }
  | { readonly state: 'searched'; readonly covered: boolean };

/**
 * The --premium-holder-name values against the holder's answer (P6-S0a). A name only partly
 * shown is likely mistyped (nothing is staged). `covered`: rule (a) of strict-text.
 */
export function holderCheck(names: readonly string[], steps: readonly RecordedStep[]): HolderCheck {
  const step = steps.find((s) => s.step === HOLDER_STEP);
  if (step === undefined) return { state: 'not-searched' };
  const presence = namePresence(names, [step.exchange.response.body]);
  const partly = presence.findIndex((p) => p.found > 0 && p.found < p.total);
  if (partly !== -1) return { state: 'partly', index: partly };
  return { state: 'searched', covered: nameCovered(names, steps, [HOLDER_STEP]) };
}

export interface StagePlan {
  readonly outputs: Array<{ readonly file: string; readonly staged: StagedFixture }>;
  /** `withheld: ...` lines for the console, one per file held back in full or in part. */
  readonly withheld: string[];
}

export interface StageRules {
  readonly sanitizer: FixtureSanitizer;
  /** Rule (a) for the owner: a read `found.name` is fully covered by --name. Else every file
   *  (pages too: a page header may show the name) is under strict text. */
  readonly ownerCovered: boolean;
}

/**
 * The step fixtures to write (the summary is added by the caller). The holder's answer, a third
 * person's, and the owner's own searches are always under strict text; every other file is when
 * rule (a) fails for the owner.
 */
export function planStaging(result: FlowResult, at: Date, rules: StageRules): StagePlan {
  const outputs: StagePlan['outputs'] = [];
  const withheld: string[] = [];
  const keep = new Set(result.keepAddresses);
  const clean = (text: string): string => rules.sanitizer.sanitizeText(text);
  const sanitizeJson = (value: unknown): unknown => rules.sanitizer.sanitizeJson(value);
  for (const s of result.steps) {
    const file = `${s.step}.json`;
    // L-1: with no API hash found, its unknown value cannot be redacted.
    if (result.apiHashLength === null) {
      withheld.push(`${file} (no api hash)`);
      continue;
    }
    if (s.step === 'page-premium-gift' && result.premiumApiHash?.found !== true) {
      withheld.push(`${file} (no api hash)`);
      continue;
    }
    const staged = fixtureOf(s, at, clean);
    const holder = s.step === HOLDER_STEP;
    // Round 2 (SA R7): the owner's own searches (error and free text) are strict even when rule
    // (a) holds: a patronymic or nickname there is in no --name.
    const ownerSearch = OWNER_SEARCH_STEPS.includes(s.step);
    if (holder || ownerSearch || !rules.ownerCovered) {
      const strict = strictFixture(staged, sanitizeJson, { keep, digits: holder });
      if (strict.withheld > 0) {
        const why =
          rules.ownerCovered || holder ? 'not plain text' : 'owner name not covered by --name';
        withheld.push(`${file} values (${strict.withheld} ${why}; strict)`);
      }
      outputs.push({ file, staged: strict.staged });
      continue;
    }
    outputs.push({ file, staged });
  }
  return { outputs, withheld };
}
