import { MANUAL_FX_SOURCE, SIMULATOR_SOURCE, isDerivedFxSource } from '@repo/shared';

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
 * derived, nor the owner's typed rate (MANUAL_FX_SOURCE, D-35 (h): a synced row named so would
 * pass for the owner's own rate), nor an empty one. Compared trimmed and case-insensitively, to
 * leave no near-miss.
 */
export function storedSourceLabel(source: LabelledSource): string | null {
  if (source.simulated) return SIMULATOR_SOURCE;
  const name = source.name.trim().toLowerCase();
  if (name === '' || name === SIMULATOR_SOURCE || name === MANUAL_FX_SOURCE) return null;
  if (isDerivedFxSource(name)) return null;
  return source.name;
}
