import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, NAV_LAYOUT } from '../nav-config';

describe('NAV_LAYOUT', () => {
  // Round 9 - Russian QA: the navigation collapses at 1040 px and below in Uzbek, 1180 px and
  // below in Russian. `min-width` classes: the first wide pixel is 1041 / 1181.
  it('uz is wide from 1041 px, ru from 1181 px', () => {
    expect(NAV_LAYOUT.uz.wide).toContain('min-[1041px]:flex');
    expect(NAV_LAYOUT.uz.narrow).toContain('min-[1041px]:hidden');
    expect(NAV_LAYOUT.ru.wide).toContain('min-[1181px]:flex');
    expect(NAV_LAYOUT.ru.narrow).toContain('min-[1181px]:hidden');
  });

  it('the anchors are the same in every language', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual(['products', 'how-it-works', 'faq']);
  });
});
