import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE,
  I18N_MODULE,
  RADIX_SCOPED,
  RAW_COLOUR,
  TOKEN_RADIUS,
} from './rule-patterns';

const SRC = resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replaceAll(sep, '/'),
  text: readFileSync(path, 'utf8'),
}));

const offending = (pattern: RegExp) =>
  FILES.filter(({ text }) => pattern.test(text)).map((file) => file.path);

describe('packages/ui source rules', () => {
  it('finds the component sources', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('never writes a colour of its own: only the token variables and token utilities', () => {
    expect(offending(RAW_COLOUR)).toEqual([]);
  });

  it('never uses the Tailwind default palette or white/black (the palette is removed)', () => {
    expect(offending(DEFAULT_PALETTE)).toEqual([]);
  });

  it('never imports the i18n layer: all text arrives through props', () => {
    expect(offending(I18N_MODULE)).toEqual([]);
  });

  it('imports Radix only through the radix-ui package, never @radix-ui/*', () => {
    expect(offending(RADIX_SCOPED)).toEqual([]);
  });

  it('never writes an arbitrary radius that a token or theme.css already provides', () => {
    expect(offending(TOKEN_RADIUS)).toEqual([]);
  });

  it('never uses dangerouslySetInnerHTML', () => {
    expect(FILES.filter(({ text }) => text.includes('dangerouslySetInnerHTML'))).toEqual([]);
  });

  it('keeps every file within the 300 line budget', () => {
    expect(FILES.filter(({ text }) => text.split('\n').length > 300).map((f) => f.path)).toEqual(
      [],
    );
  });

  it('uses the handoff attribute data-reduced, the one tokens.css listens to', () => {
    const tokens = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8');
    expect(tokens).toContain('[data-reduced="true"]');
    const motion = FILES.find((f) => f.path === 'lib/motion.ts')?.text ?? '';
    expect(motion).toContain("'data-reduced'");
    expect(FILES.some((f) => f.text.includes('data-reduced-motion'))).toBe(false);
  });

  it('uses the extra radii only through theme.css names that theme.css defines', () => {
    const theme = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');
    for (const name of ['badge', 'control', 'tile']) {
      expect(theme).toContain(`--radius-${name}:`);
    }
  });
});

describe('rule patterns catch what they should', () => {
  it.each([
    'color: #3D4BF5',
    'bg-[#fff]',
    'style={{ color: "rgb(1, 2, 3)" }}',
    'hsl(10 20% 30%)',
    'hsla(10 20% 30% / .5)',
    'oklch(0.7 0.1 200)',
    'bg-[white]',
    'text-[black]',
    'border-[transparent]',
    'color-mix(in oklab, var(--primary) 16%, transparent)',
    'bg-[color-mix(in_oklab,var(--primary)_16%,transparent)]',
    '[color:red]',
    '[background-color:var(--x)]',
    '[fill:#fff]',
    '[stroke:blue]',
    "style={{ color: 'white' }}",
    'style={{ backgroundColor: "red" }}',
    '<svg fill="white" />',
    '<path stroke="black" />',
    'style={{ color: `white` }}',
  ])('flags colour %s', (text) => {
    expect(RAW_COLOUR.test(text)).toBe(true);
  });

  it.each([
    'bg-primary',
    'text-foreground-muted',
    'shadow-[0_0_0_1px_var(--ring)]',
    'hover:bg-danger-hover',
    'bg-[linear-gradient(var(--success),var(--info))]',
    '<svg fill="currentColor" />',
    "style={{ color: 'var(--primary)' }}",
    "style={{ background: 'transparent' }}",
    '<path stroke="none" />',
    "style={{ color: 'inherit' }}",
    "style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}",
    'bg-[linear-gradient(90deg,transparent,var(--skeleton-shine),transparent)]',
  ])('allows token class %s', (text) => {
    expect(RAW_COLOUR.test(text)).toBe(false);
    expect(DEFAULT_PALETTE.test(text)).toBe(false);
  });

  it.each([
    'text-white',
    'bg-black',
    'dark:bg-slate-900',
    'hover:text-red-500',
    'border-gray-200',
    'ring-blue-500',
  ])('flags default-palette class %s', (text) => {
    expect(DEFAULT_PALETTE.test(text)).toBe(true);
  });

  it.each([
    "import { useTranslations } from 'next-intl';",
    "import 'next-intl';",
    "export * from '@repo/i18n/uz.json';",
    "const t = require('next-intl/server');",
    "const m = await import('@repo/i18n');",
    'const m = await import(`next-intl`);',
    'import x from `@repo/i18n/ru.json`;',
    'const t = require(`next-intl`);',
  ])('flags an i18n load: %s', (text) => {
    expect(I18N_MODULE.test(text)).toBe(true);
  });

  it.each([
    'rounded-[12px]',
    'md:rounded-[24px]',
    'rounded-t-[28px]',
    'rounded-[6px]',
    'rounded-3xl',
    'md:rounded-4xl',
    'rounded-t-3xl',
    'rounded-[1rem]',
    'rounded-b-[0.75rem]',
  ])('flags a token-equal radius %s', (text) => {
    expect(TOKEN_RADIUS.test(text)).toBe(true);
  });

  it.each([
    'rounded-lg',
    'rounded-2xl',
    'rounded-control',
    'rounded-full',
    'rounded-[5px]',
    'rounded-t-[3px]',
  ])('allows radius %s', (text) => {
    expect(TOKEN_RADIUS.test(text)).toBe(false);
  });

  it.each([
    "import { Dialog } from '@radix-ui/react-dialog';",
    'import { Dialog } from "@radix-ui/react-dialog";',
    'const d = await import(`@radix-ui/react-dialog`);',
  ])('flags a scoped Radix import: %s', (text) => {
    expect(RADIX_SCOPED.test(text)).toBe(true);
  });

  it.each(["import { Dialog } from 'radix-ui';", "import { Slot } from 'radix-ui';"])(
    'allows %s',
    (text) => {
      expect(RADIX_SCOPED.test(text)).toBe(false);
    },
  );

  it.each(["import { motion } from 'motion/react';", "import { Check } from 'lucide-react';"])(
    'does not mistake %s for an i18n load',
    (text) => {
      expect(I18N_MODULE.test(text)).toBe(false);
    },
  );
});
