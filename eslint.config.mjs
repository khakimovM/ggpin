// Root flat config: every workspace runs `eslint .` and resolves this file upwards.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ---- Boundary rules ---------------------------------------------------------------------
// `process.env` outside src/config. The plain `process.env` member is covered by
// no-restricted-properties; these catch the spellings that rule cannot see.
const ENV_MESSAGE = 'Read env only via src/config.';
const PROCESS_ENV_SYNTAX = [
  {
    // globalThis.process.env, global.process.env, window.process.env
    selector:
      "MemberExpression[object.type='MemberExpression'][object.property.name='process'][property.name='env']",
    message: ENV_MESSAGE,
  },
  {
    selector:
      "MemberExpression[object.type='MemberExpression'][object.property.name='process'][property.value='env']",
    message: ENV_MESSAGE,
  },
  {
    // const { env } = process;
    selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
    message: ENV_MESSAGE,
  },
];
const PROCESS_ENV_IMPORTS = ['process', 'node:process'].map((name) => ({
  name,
  importNames: ['env'],
  message: ENV_MESSAGE,
}));

// Worker-only code: TON libraries (current and legacy package names) and apps/worker itself.
// The regexes are esquery literals (between slashes), so a slash inside them is escaped with a backslash.
const TON_RE = String.raw`^(@ton\/.+|ton|ton-core|ton-crypto|tonweb)$`;
const WORKER_RE = String.raw`(^worker$|^worker\/|apps\/worker\/|^(\.\.\/)+.*worker\/(src|dist)\/)`;
const TON_MESSAGE = 'TON code belongs to apps/worker only.';
const WORKER_MESSAGE = 'Do not import from apps/worker; share code through packages/*.';
const WORKER_ONLY_PATHS = ['ton', 'ton-core', 'ton-crypto', 'tonweb', 'worker'].map((name) => ({
  name,
  message: name === 'worker' ? WORKER_MESSAGE : TON_MESSAGE,
}));
const WORKER_ONLY_PATTERNS = [
  { group: ['@ton/*', 'ton-*'], message: TON_MESSAGE },
  {
    group: ['worker/*', '**/apps/worker/**', '../**/worker/src/**', '../**/worker/dist/**'],
    message: WORKER_MESSAGE,
  },
];
const dynamicImport = (re, message) => [
  { selector: `ImportExpression[source.value=/${re}/]`, message },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`, message },
];
const WORKER_ONLY_SYNTAX = [
  ...dynamicImport(TON_RE, TON_MESSAGE),
  ...dynamicImport(WORKER_RE, WORKER_MESSAGE),
];

// The reverse direction: apps/worker must not reach into apps/api (it would drag HTTP, bot and
// payment-webhook code into the only process that holds wallet keys). Shared code goes through
// packages/*. The package name of apps/api is "api"; the relative form is `../**/api/(src|dist)/`.
const API_RE = String.raw`(^api$|^api\/|apps\/api\/|^(\.\.\/)+(.*\/)?api\/(src|dist)\/)`;
const API_MESSAGE = 'Do not import from apps/api; share code through packages/*.';
const API_ONLY_PATHS = [{ name: 'api', message: API_MESSAGE }];
const API_ONLY_PATTERNS = [
  {
    group: ['api/*', '**/apps/api/**', '../**/api/src/**', '../**/api/dist/**'],
    message: API_MESSAGE,
  },
];
const API_ONLY_SYNTAX = dynamicImport(API_RE, API_MESSAGE);

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Prisma client output (packages/db/src/generated) is generated code.
      '**/generated/**',
      '**/next-env.d.ts',
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
        { object: 'process', property: 'env', message: ENV_MESSAGE },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SYNTAX],
      'no-restricted-imports': ['error', { paths: PROCESS_ENV_IMPORTS }],
    },
  },
  {
    // CLAUDE.md §5.7: wallet code and its secrets live in apps/worker only. Closes the
    // bypasses of a plain static `@ton/*` import: dynamic import()/require(), the legacy
    // package names, and reaching into apps/worker by relative path or package name.
    files: ['apps/api/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: WORKER_ONLY_PATHS, patterns: WORKER_ONLY_PATTERNS },
      ],
      'no-restricted-syntax': ['error', ...WORKER_ONLY_SYNTAX],
    },
  },
  {
    // apps/api (outside config) is under both rule sets above; flat config replaces a rule's
    // options instead of merging them, so the combined set is restated for these files.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...PROCESS_ENV_IMPORTS, ...WORKER_ONLY_PATHS],
          patterns: WORKER_ONLY_PATTERNS,
        },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SYNTAX, ...WORKER_ONLY_SYNTAX],
    },
  },
  {
    files: ['apps/worker/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: API_ONLY_PATHS, patterns: API_ONLY_PATTERNS }],
      'no-restricted-syntax': ['error', ...API_ONLY_SYNTAX],
    },
  },
  {
    // Same restating as for apps/api above: the worker (outside config) is under both rule sets.
    files: ['apps/worker/src/**/*.ts'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...PROCESS_ENV_IMPORTS, ...API_ONLY_PATHS], patterns: API_ONLY_PATTERNS },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SYNTAX, ...API_ONLY_SYNTAX],
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
