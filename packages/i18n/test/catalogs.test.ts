import { describe, expect, it } from 'vitest';
import ru from '../ru.json';
import uz from '../uz.json';

type Catalog = { [key: string]: string | Catalog };

// Flattens nested catalogs to `area.screen.element` keys so both locales can be compared.
function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const uzKeys = flatten(uz);
const ruKeys = flatten(ru);

describe('i18n catalogs', () => {
  it('uz and ru have identical key sets', () => {
    expect([...uzKeys.keys()].sort()).toEqual([...ruKeys.keys()].sort());
  });

  it('has no empty strings', () => {
    for (const [locale, keys] of [
      ['uz', uzKeys],
      ['ru', ruKeys],
    ] as const) {
      for (const [key, value] of keys) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  // .claude/rules/35-i18n.md: o‘ and g‘ use U+2018; tutuq belgisi uses U+02BC. A plain ASCII
  // apostrophe or backtick in Uzbek text is always a typo.
  it("uz uses typographic apostrophes, never ASCII ' or `", () => {
    for (const [key, value] of uzKeys) {
      expect(value, `uz:${key}`).not.toMatch(/['`]/);
    }
  });

  // U+02BC is allowed after o/g: it can be a genuine tutuq belgisi, not a misspelt o‘/g‘.
  it('uz writes o‘ and g‘ with U+2018', () => {
    for (const [key, value] of uzKeys) {
      expect(value, `uz:${key}`).not.toMatch(/[oOgG][’ʻ]/);
    }
  });
});
