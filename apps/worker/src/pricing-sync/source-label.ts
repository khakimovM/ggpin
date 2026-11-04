import { SIMULATOR_SOURCE, isDerivedFxSource } from '@repo/shared';

/** What every price source (FxSource, CostSource) declares about itself. */
export interface LabelledSource {
  /** Free text chosen by whoever wrote the source. */
  readonly name: string;
  readonly simulated: boolean;
}

/**
 * The `source` stored on FxRate / CostSnapshot rows from `source`, or null when the source must
 * be refused. The API decides "fake or real" from this label alone (it refuses SIMULATOR_SOURCE
 * and rates derived from it in production), so the label follows the `simulated` flag, never the
 * free-text name: a fake source named anything else would otherwise be stored as real.
 *
 * The reverse is refused too: a real source may not take a name the API reads as simulated or
 * derived (compared trimmed and case-insensitively, to leave no near-miss), nor an empty one.
 */
export function storedSourceLabel(source: LabelledSource): string | null {
  if (source.simulated) return SIMULATOR_SOURCE;
  const name = source.name.trim().toLowerCase();
  if (name === '' || name === SIMULATOR_SOURCE || isDerivedFxSource(name)) return null;
  return source.name;
}
