import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static scanner (plan 5.3, CLAUDE.md §5): money in the panel is a tiyin string or a BigInt, never a
// JS number. A money-named value passed to Number / parseFloat / parseInt, a `.toFixed` on a money
// line, or `amount * 100` style conversion is a finding. Non-money numbers (bps, percent, page) are
// untouched because the rule looks for money words inside the converted expression.

const ROOT = join(__dirname, '..');
const MONEY = /(tiyin|amount|balance|price|som\b|limit(?:Tiyin)?\b)/i;
const RULES: { name: string; test: (line: string) => boolean }[] = [
  {
    name: 'Number/parseFloat/parseInt on money',
    test: (line) =>
      [...line.matchAll(/\b(?:Number|parseFloat|parseInt)\(([^)]*)\)/g)].some((match) =>
        MONEY.test(match[1] ?? ''),
      ),
  },
  { name: 'toFixed on a money line', test: (line) => /\.toFixed\(/.test(line) && MONEY.test(line) },
  {
    name: '* 100 on money',
    test: (line) =>
      /(tiyin|amount|som)\w*\s*\*\s*100\b|\b100\s*\*\s*\w*(tiyin|amount|som)/i.test(line),
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('no number money in apps/admin/src', () => {
  it('finds no Number()/parseFloat/toFixed/×100 on money values', () => {
    const findings = sources(ROOT).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => {
          if (/^\s*(\/\/|\*)/.test(line)) return [];
          return RULES.filter((rule) => rule.test(line)).map(
            (rule) => `${relative(ROOT, file)}:${index + 1} ${rule.name}: ${line.trim()}`,
          );
        }),
    );
    expect(findings).toEqual([]);
  });

  it('the scanner itself catches the patterns it is for', () => {
    const [numberRule, fixedRule, hundredRule] = RULES;
    expect(numberRule?.test('const x = Number(row.amountTiyin);')).toBe(true);
    expect(numberRule?.test('parseFloat(balance)')).toBe(true);
    expect(numberRule?.test('formatBps(Number(setting.value))')).toBe(false);
    expect(fixedRule?.test('(amount / 100).toFixed(2)')).toBe(true);
    expect(hundredRule?.test('const tiyin = som * 100;')).toBe(true);
  });
});
