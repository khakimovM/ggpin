// Root flat config: every workspace runs `eslint .` and resolves this file upwards.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      // Claude Design export: generated runtime JS, kept verbatim (lint-staged would rewrite it).
      'design/**',
    ],
  },
  js.configs.recommended,
  // Type-aware: a dropped `await` on a $transaction or ledger write is exactly the money bug
  // lint must catch (no-floating-promises, no-misused-promises).
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { projectService: true },
    },
    rules: {
      // CLAUDE.md §9: no `any`, no `!`, no @ts-ignore — enforced, not just documented.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // .claude/rules/10-backend-nestjs.md: config only through the validated config module.
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read env only via src/config.' },
      ],
    },
  },
  {
    // CLAUDE.md §5.7: wallet code and its secrets live in apps/worker only.
    files: ['apps/api/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@ton/*'], message: 'TON code belongs to apps/worker only.' }] },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only: there is no pages/ directory for this rule to check.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  prettier,
);
