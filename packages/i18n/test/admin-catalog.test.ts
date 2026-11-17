import { describe, expect, it } from 'vitest';
import admin from '../admin.uz.json';
import ru from '../ru.json';
import uz from '../uz.json';

// The admin panel's catalog (D-63 (9), Q14): Uzbek only, so it lives apart from uz/ru, which must
// keep identical key sets. These checks replace that parity test for the admin texts.

function flatten(catalog: unknown, prefix = ''): Map<string, string> {
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    throw new Error(`"${prefix}" must be a string or a nested object`);
  }
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const keys = flatten(admin);

describe('admin.uz.json', () => {
  it('has the single top-level namespace `admin`', () => {
    expect(Object.keys(admin)).toEqual(['admin']);
    expect(keys.size).toBeGreaterThan(50);
  });

  it('keeps the area.screen.element key style (camelCase segments)', () => {
    for (const key of keys.keys()) {
      expect(key, key).toMatch(/^admin(\.[A-Za-z][A-Za-z0-9]*)+$/);
    }
  });

  it('has no empty strings', () => {
    for (const [key, value] of keys) expect(value.trim(), key).not.toBe('');
  });

  it("uses typographic apostrophes, never ASCII ' or `", () => {
    for (const [key, value] of keys) expect(value, key).not.toMatch(/['`]/);
  });

  it('writes o‘ and g‘ with U+2018', () => {
    for (const [key, value] of keys) expect(value, key).not.toMatch(/[oOgG][’ʻ]/);
  });

  it('balances the braces of every ICU message', () => {
    for (const [key, value] of keys) {
      let depth = 0;
      for (const char of value) {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        expect(depth, key).toBeGreaterThanOrEqual(0);
      }
      expect(depth, key).toBe(0);
    }
  });

  it('is the only home of admin texts: uz.json and ru.json carry no `admin` namespace', () => {
    expect(Object.keys(uz)).not.toContain('admin');
    expect(Object.keys(ru)).not.toContain('admin');
  });
});
