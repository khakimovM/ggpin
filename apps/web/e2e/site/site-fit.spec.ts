import { expect, test, type Locator, type Page } from '@playwright/test';
import { INFO_LANGS, openInfo } from './info-support';
import { LANDING, openLanding } from './landing-support';
import { openProduct, PRODUCTS, productCopy, productPath } from './product-support';

// What the design QA of phase 8 S3 measured by eye (design-qa M1, M2, M3, m7), kept as checks:
//  - corners: the package rows, the fact cards and the buttons are the design's 16 px (here the
//    token `rounded-2xl` is 28 px, not Tailwind's 16), and a tile's delivery chip is 6 px;
//  - the badges over a tile's picture stay inside it and apart, however long the label;
//  - "1–2" (joined by U+2060 in the catalogs) is never split over two lines, at any width;
//  - a product page's placeholders take the room of the catalog's answer: nothing moves when it
//    arrives (the layout shift the S3 fix round measured).

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const radius = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).borderRadius);

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not on screen');
  return box;
}

// Half a pixel of slack: boxes are fractional.
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x + 0.5 ||
  b.x + b.width <= a.x + 0.5 ||
  a.y + a.height <= b.y + 0.5 ||
  b.y + b.height <= a.y + 0.5;

const WIDTHS = [360, 390, 768, 1024, 1180, 1440];

/** How many joined "1–2" are on screen, and those a line break splits (with their context). */
function joinedRanges(page: Page) {
  return page.evaluate(() => {
    const joined = '1\u2060–\u20602';
    const split: string[] = [];
    let seen = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let at = text.indexOf(joined); at !== -1; at = text.indexOf(joined, at + 1)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + joined.length);
        const tops = [...range.getClientRects()].map((rect) => rect.top);
        // Not drawn (the answer of a closed question): nothing to wrap.
        if (tops.length === 0) continue;
        seen += 1;
        // Two lines are a line height apart; the pieces of one line differ by a pixel or two.
        if (Math.max(...tops) - Math.min(...tops) > 8) {
          split.push(text.slice(Math.max(0, at - 16), at + 21));
        }
      }
    }
    return { seen, split };
  });
}

async function expectJoinedAtEveryWidth(page: Page, where: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const { seen, split } = await joinedRanges(page);
    expect(seen, `${where} @${width}px`).toBeGreaterThan(0);
    expect(split, `${where} @${width}px`).toEqual([]);
  }
}

interface Held {
  __release: () => number;
}

/**
 * Holds React's calls that put a finished part of the page in place of its placeholder (`$RC`),
 * until `__release()`. With the page's own scripts blocked (no hydration) the placeholders stay on
 * the screen as long as the test likes.
 */
function holdTheAnswer() {
  const queue: [string, string][] = [];
  let complete: ((boundary: string, segment: string) => void) | null = null;
  Object.defineProperty(window, '$RC', {
    configurable: true,
    get: () => (boundary: string, segment: string) => {
      queue.push([boundary, segment]);
    },
    set: (fn: (boundary: string, segment: string) => void) => {
      complete = fn;
    },
  });
  (window as unknown as Held).__release = () => {
    for (const [boundary, segment] of queue) complete?.(boundary, segment);
    return queue.length;
  };
}

/**
 * The placeholders of the first block (ProductHero: the facts, the chips, the package list). The
 * related products' grid is not counted: with a warm cache its answer may come with the first bytes.
 */
const HERO_PLACEHOLDERS = 3;

/** The heights of the first block's two columns and where the next block starts (half pixels). */
const heroLayout = (page: Page) =>
  page.evaluate(() => {
    const hero = document.querySelector('section[aria-labelledby="product-title"]');
    if (hero === null) throw new Error('no product hero');
    const half = (value: number) => Math.round(value * 2) / 2;
    const next = hero.nextElementSibling;
    return {
      columns: [...hero.children].map((column) => half(column.getBoundingClientRect().height)),
      next: next === null ? null : half(next.getBoundingClientRect().top + scrollY),
    };
  });

for (const lang of ['uz', 'ru'] as const) {
  test.describe(`${lang}: what must fit`, () => {
    test('a product page: rows, fact cards and buttons have the 16 px corners of the design', async ({
      page,
    }) => {
      const { common } = productCopy('stars', lang);
      await openProduct(page, 'telegram-stars', lang);
      const main = page.getByRole('main');
      expect(await radius(main.getByRole('radio').first())).toBe('16px');
      expect(await radius(main.locator('dl > div').first())).toBe('16px');
      const buy = main.getByRole('link', { name: new RegExp(`^${common.buy.label}`) });
      expect(await radius(buy)).toBe('16px');
      expect(await radius(main.getByRole('link', { name: common.telegram }))).toBe('16px');
    });

    test('the landing: 16 px hero buttons, a 6 px tile chip, and tile badges that fit', async ({
      page,
    }) => {
      const { copy, catalog } = LANDING[lang];
      await openLanding(page, lang);
      const hero = page.locator('section[aria-labelledby="hero-title"]');
      expect(await radius(hero.getByRole('link', { name: copy.cta.telegram }))).toBe('16px');
      expect(await radius(hero.getByRole('link', { name: copy.cta.store }))).toBe('16px');
      const products = page.locator('#products');
      const chip = products.getByText(catalog.badge.auto, { exact: true }).first();
      expect(await radius(chip)).toBe('6px');

      // PUBG Mobile is the fixture's tile with both badges: "popular" and its region.
      const tile = products.getByRole('listitem').filter({ hasText: 'PUBG Mobile' });
      const popular = tile.getByText(catalog.badge.popular, { exact: true });
      const region = tile.getByText('GLOBAL', { exact: true });
      // The badge's row, then the picture that clips it.
      const picture = popular.locator('xpath=../..');
      const [first, second, art] = await Promise.all([
        boxOf(popular),
        boxOf(region),
        boxOf(picture),
      ]);
      expect(inside(first, art), 'the popular badge is inside the picture').toBe(true);
      expect(inside(second, art), 'the region badge is inside the picture').toBe(true);
      expect(apart(first, second), 'the two badges do not overlap').toBe(true);
      // With room for both (the row is the picture less 8 px a side, 4 px between them) they share
      // the top row, as the design draws them.
      if (art.width - 16 >= first.width + second.width + 4) {
        expect(Math.abs(second.y - first.y)).toBeLessThan(1);
      }
    });

    test('"1–2" stays on one line on the product pages and the landing, at any width', async ({
      page,
    }) => {
      for (const slug of ['telegram-premium', 'telegram-stars'] as const) {
        await openProduct(page, slug, lang);
        await expectJoinedAtEveryWidth(page, slug);
      }
      await openLanding(page, lang);
      await expectJoinedAtEveryWidth(page, 'landing');
    });

    test('"1–2" stays on one line on the FAQ page: the landing’s answer and the help screen’s', async ({
      page,
    }) => {
      const { copy } = INFO_LANGS[lang];
      await openInfo(page, 'faq', lang);
      // The first question is open: the landing's "Odatda 1–2 daqiqa".
      await expectJoinedAtEveryWidth(page, 'faq, the first answer');
      // The help screen's wallet top-up answer ("1–2 daqiqada tushadi"); opening it closes the first.
      const topUp = page
        .getByRole('main')
        .locator('details')
        .filter({ hasText: copy.account.help.faq.q4 });
      await topUp.locator('summary').click();
      await expect(topUp).toHaveAttribute('open', '');
      await expectJoinedAtEveryWidth(page, 'faq, the top-up answer');
    });

    test('a product page: the placeholders take the room of the answer, nothing moves when it comes', async ({
      page,
    }) => {
      await page.route('**/_next/static/chunks/**', (route) => route.abort());
      await page.addInitScript(holdTheAnswer);
      for (const { slug } of PRODUCTS) {
        await page.goto(productPath(slug, lang));
        await page.getByRole('heading', { level: 1 }).waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        // The first block shows its placeholders, not the answer (a warm cache could send that with
        // the first bytes): else the test would measure the answer twice and prove nothing.
        const hero = page.locator('section[aria-labelledby="product-title"]');
        const ghosts = hero.locator('[data-ghost]');
        expect(await ghosts.count(), `${slug}: the placeholders' texts`).toBeGreaterThan(0);
        await expect(hero.locator('[role="status"]')).toHaveCount(1);
        const placeholders = await heroLayout(page);
        const released = await page.evaluate(() => (window as unknown as Held).__release());
        expect(released, `${slug}: the placeholders were held`).toBeGreaterThanOrEqual(
          HERO_PLACEHOLDERS,
        );
        await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0);
        await expect(ghosts, `${slug}: no placeholder is left`).toHaveCount(0);
        expect(await heroLayout(page), slug).toEqual(placeholders);
      }
    });
  });
}
