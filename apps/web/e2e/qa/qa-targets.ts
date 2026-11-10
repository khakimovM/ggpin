import type { Page } from '@playwright/test';

// Phase 7 S11: measuring the pressable area of controls.
//
// The drawn size of a control stays the design's (36/40 px chips, a 36 px "Yopish"), so the box of
// the element alone says little. What counts is the EFFECTIVE area: the element's box together
// with its transparent hit-area pseudo-element (`before:` / `after:`, HIT_AREA_* in packages/ui),
// as far as it really is there:
//  - the pseudo-element is clipped by every ancestor with `overflow` other than `visible` (a chip
//    row with `overflow-x-auto` clips it at the row's padding box);
//  - the points of its box are hit-tested with `document.elementFromPoint`: if something else
//    covers a point (another control's area, an overlay), that area is not the control's.

export const TOUCH_MIN = 44;
export const DESKTOP_MIN = 24;
/** On the web a viewport narrower than this is a touch context; the Mini App always is. */
export const TOUCH_BELOW = 768;

export const CONTROLS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], [role="link"], [role="menuitem"]';

export interface Small {
  what: string;
  width: number;
  height: number;
}

export interface TargetProblems {
  small: Small[];
  overlaps: string[];
  /** Points of a hit area where another element, not the control, takes the tap. */
  covered: string[];
}

/**
 * Controls whose effective pressable area is below `min`, pairs of controls whose areas overlap
 * (a tap must not go to the neighbour), and hit areas that something else covers. A control marked
 * data-hit="y" has a vertical-only hit area on purpose (the promo dots sit on a 24 px pitch, a
 * wider area would take the neighbour's taps): it is held to `min` high and to the desktop floor
 * wide.
 */
export async function targetProblems(page: Page, min: number): Promise<TargetProblems> {
  return page.evaluate(
    ({ selector, minSize, floor }) => {
      interface Box {
        left: number;
        top: number;
        right: number;
        bottom: number;
      }
      const num = (value: string) => Number.parseFloat(value) || 0;
      // The pseudo-element is placed against its containing block: the element itself when it is
      // positioned, otherwise the nearest positioned ancestor (a "stretched link" reaches its row).
      const containingBlock = (el: Element): Element => {
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          const cs = getComputedStyle(node);
          if (
            cs.position !== 'static' ||
            cs.transform !== 'none' ||
            cs.filter !== 'none' ||
            /paint|layout/.test(cs.contain)
          ) {
            return node;
          }
        }
        return document.documentElement;
      };
      /** The part of `box` that the overflow of the containing block and its ancestors lets through. */
      const clip = (box: Box, from: Element): Box => {
        const out = { ...box };
        for (
          let node: Element | null = from;
          node !== null && node !== document.documentElement && node !== document.body;
          node = node.parentElement
        ) {
          const cs = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (cs.overflowX !== 'visible') {
            out.left = Math.max(out.left, rect.left + num(cs.borderLeftWidth));
            out.right = Math.min(out.right, rect.right - num(cs.borderRightWidth));
          }
          if (cs.overflowY !== 'visible') {
            out.top = Math.max(out.top, rect.top + num(cs.borderTopWidth));
            out.bottom = Math.min(out.bottom, rect.bottom - num(cs.borderBottomWidth));
          }
        }
        if (out.right < out.left) out.right = out.left;
        if (out.bottom < out.top) out.bottom = out.top;
        return out;
      };
      const pseudoBox = (el: Element, which: '::before' | '::after'): Box | null => {
        const ps = getComputedStyle(el, which);
        if (ps.content === 'none' || ps.position !== 'absolute') return null;
        const block = containingBlock(el);
        const blockRect = block.getBoundingClientRect();
        const blockStyle = getComputedStyle(block);
        const width = num(ps.width);
        const height = num(ps.height);
        let tx = 0;
        let ty = 0;
        // Tailwind 4 moves a box with the `translate` property ("-50% -50%"), not with `transform`.
        if (ps.translate !== 'none' && ps.translate !== '') {
          const [x = '0px', y = '0px'] = ps.translate.split(' ');
          tx = x.endsWith('%') ? (num(x) / 100) * width : num(x);
          ty = y.endsWith('%') ? (num(y) / 100) * height : num(y);
        }
        if (ps.transform !== 'none') {
          const m = new DOMMatrixReadOnly(ps.transform);
          tx += m.m41;
          ty += m.m42;
        }
        const left = blockRect.left + num(blockStyle.borderLeftWidth) + num(ps.left) + tx;
        const top = blockRect.top + num(blockStyle.borderTopWidth) + num(ps.top) + ty;
        return clip({ left, top, right: left + width, bottom: top + height }, block);
      };
      /** The element's box and its (clipped) pseudo boxes, and the union of them all. */
      const areas = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const union: Box = {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        };
        const pseudos: Box[] = [];
        for (const which of ['::before', '::after'] as const) {
          const extra = pseudoBox(el, which);
          if (extra === null) continue;
          pseudos.push(extra);
          union.left = Math.min(union.left, extra.left);
          union.top = Math.min(union.top, extra.top);
          union.right = Math.max(union.right, extra.right);
          union.bottom = Math.max(union.bottom, extra.bottom);
        }
        return { union, pseudos };
      };

      // A control inside a fixed bar (the Mini App tab bar, the buy bar) floats over the page: the
      // content under it scrolls beneath, it is not a neighbour a tap could go to.
      const inFixed = (el: Element) => {
        for (let node: Element | null = el; node !== null; node = node.parentElement) {
          if (getComputedStyle(node).position === 'fixed') return true;
        }
        return false;
      };
      const describe = (target: Element) => {
        const name = (target.getAttribute('aria-label') ?? target.textContent ?? '')
          .trim()
          .slice(0, 30);
        return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''} "${name}"`;
      };

      window.scrollTo(0, 0);
      const small: Small[] = [];
      const taken: Array<{ el: Element; box: Box; what: string; fixed: boolean }> = [];
      const seen = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (el.closest('[aria-hidden="true"], [inert], [hidden]') !== null) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (style.pointerEvents === 'none') continue;
        let target = el;
        // A visually hidden native input (radio, checkbox) is operated through its label.
        const rect0 = el.getBoundingClientRect();
        if (rect0.width <= 2 || rect0.height <= 2 || Number.parseFloat(style.opacity) === 0) {
          const label = el.closest('label, [role="radio"]');
          if (label === null) continue;
          target = label;
        }
        if (seen.has(target)) continue;
        seen.add(target);
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Inside a sentence: an inline link in a paragraph is exempt.
        if (target.tagName === 'A' && getComputedStyle(target).display === 'inline') {
          const block = target.closest('p, li, dd');
          if (
            block !== null &&
            (block.textContent ?? '').trim() !== (target.textContent ?? '').trim()
          ) {
            continue;
          }
        }
        const { union: box } = areas(target);
        const width = box.right - box.left;
        const height = box.bottom - box.top;
        const needWidth = target.getAttribute('data-hit') === 'y' ? floor : minSize;
        const what = describe(target);
        // Half a pixel of tolerance for sub-pixel layout (a 44 px area can measure 43.7).
        if (width < needWidth - 0.5 || height < minSize - 0.5) {
          small.push({ what, width: Math.round(width), height: Math.round(height) });
        }
        taken.push({ el: target, box, what, fixed: inFixed(target) });
      }

      const overlaps: string[] = [];
      for (let i = 0; i < taken.length; i += 1) {
        for (let j = i + 1; j < taken.length; j += 1) {
          const a = taken[i];
          const b = taken[j];
          if (a === undefined || b === undefined) continue;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (a.fixed !== b.fixed) continue;
          const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
          const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
          // One pixel of slack: two areas that merely touch, borders, rounding.
          if (w > 1 && h > 1) {
            overlaps.push(`${a.what} x ${b.what} (${Math.round(w)}x${Math.round(h)})`);
          }
        }
      }

      // Hit test: the four corners and four edge middles (2 px inside) of every pseudo-element
      // area must belong to the control. The control is brought to the middle of the viewport
      // first, so a fixed bar does not stand over it.
      // 2 px inside: a collapsed table border or a rounding step moves a box by a pixel.
      const INSET = 2;
      const covered: string[] = [];
      for (const { el, what } of taken) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        for (const pseudo of areas(el).pseudos) {
          const { left, top, right, bottom } = pseudo;
          if (right - left < 4 || bottom - top < 4) continue;
          const midX = (left + right) / 2;
          const midY = (top + bottom) / 2;
          const points: Array<[number, number]> = [
            [left + INSET, top + INSET],
            [midX, top + INSET],
            [right - INSET, top + INSET],
            [left + INSET, midY],
            [right - INSET, midY],
            [left + INSET, bottom - INSET],
            [midX, bottom - INSET],
            [right - INSET, bottom - INSET],
          ];
          for (const [x, y] of points) {
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit === null || el.contains(hit)) continue;
            covered.push(`${what} at ${Math.round(x)},${Math.round(y)} -> ${describe(hit)}`);
            break;
          }
        }
      }
      window.scrollTo(0, 0);
      return { small, overlaps, covered };
    },
    { selector: CONTROLS, minSize: min, floor: DESKTOP_MIN },
  );
}
