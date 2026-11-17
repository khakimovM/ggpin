import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTranslator } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ADMIN_LOCALE, messages } from '../lib/i18n';

const SRC = resolve(__dirname, '..');

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') out.set(path, child);
    else for (const [k, v] of flatten(child, path)) out.set(k, v);
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const catalog = flatten(messages);

describe('admin i18n', () => {
  it('formats every message with ICU (valid syntax, every argument known)', () => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: ADMIN_LOCALE,
      messages,
      onError: (error) => errors.push(error.message),
    });
    const translate = t as unknown as (key: string, values: Record<string, unknown>) => string;
    for (const [key, message] of catalog) {
      const names = [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((m) => m[1] ?? '');
      const values = Object.fromEntries(names.map((name) => [name, 1]));
      const text = translate(key, values);
      expect(text, key).not.toContain('{');
    }
    expect(errors).toEqual([]);
  });

  it('every literal key used in the source exists in the catalog', () => {
    const missing: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'((?:admin|errors)\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1] ?? '';
        if (!catalog.has(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('finds the keys it checks (the scan is not empty)', () => {
    const used = sources(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
      .match(/\bt\(\s*'admin\./g);
    expect(used?.length ?? 0).toBeGreaterThan(40);
  });

  it('carries the API error texts of uz.json (backend-owned)', () => {
    expect(catalog.get('errors.NOT_FOUND')).toBeTruthy();
    expect(catalog.get('errors.CODE_INVALID')).toBeTruthy();
  });
});
