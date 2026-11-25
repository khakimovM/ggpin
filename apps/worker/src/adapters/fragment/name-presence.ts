import { namePieces, pieceProbe } from './leak-probes';
import { allViews, loweredViews } from './leak-views';

// Is each --name really what the answers show (F-5, round 4 M-1)? A name the owner mistyped
// (`Karimovaa`) or transliterated (`Hakimov` for `Xakimov`) would leave the real spelling
// unredacted, so the recorder stages nothing unless every piece of a name is found.

export interface NamePresence {
  /** Pieces of this --name found in at least one answer. */
  readonly found: number;
  readonly total: number;
}

/** For each name: how many of its space-separated pieces (3+ characters) the texts show. */
export function namePresence(names: readonly string[], texts: readonly string[]): NamePresence[] {
  const views = texts.map((text) => loweredViews(allViews(text)));
  return names.map((name) => {
    const pieces = namePieces(name);
    const all = pieces.length > 0 ? pieces : [name.trim()];
    const found = all.filter((piece) => {
      const probe = pieceProbe(piece);
      return views.some((list) => list.some(probe));
    }).length;
    return { found, total: all.length };
  });
}
