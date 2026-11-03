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

// Worker-only code: TON libraries (current and legacy package names, and the wider ecosystems
// `@ton-community/*`, `@ton-*/*`, `ton-*`, `tonweb*`) and apps/worker itself.
// The regexes are esquery literals (between slashes), so a slash inside them is escaped with a backslash.
const TON_RE = String.raw`^(@ton\/.+|@ton-[^\/]+(\/.*)?|ton|ton-.+|tonweb.*)$`;
// Directory imports count too: `../../worker/src` has no trailing slash.
const WORKER_RE = String.raw`(^worker$|^worker\/|apps\/worker(\/|$)|^(\.\.\/)+(.*\/)?worker\/(src|dist)(\/|$))`;
const TON_MESSAGE = 'TON code belongs to apps/worker only.';
const WORKER_MESSAGE = 'Do not import from apps/worker; share code through packages/*.';
// node:module (createRequire) is a second require() the checks cannot follow, so it is refused
// wherever the TON boundary applies.
const MODULE_MESSAGE =
  'node:module (createRequire) is a second require() that bypasses the import-boundary rules.';
const MODULE_PATHS = ['module', 'node:module'].map((name) => ({ name, message: MODULE_MESSAGE }));
const TON_PACKAGE_PATHS = ['ton', 'ton-core', 'ton-crypto', 'tonweb'].map((name) => ({
  name,
  message: TON_MESSAGE,
}));
const TON_PATHS = [...TON_PACKAGE_PATHS, ...MODULE_PATHS];
const TON_PATTERNS = [
  {
    group: ['@ton/*', '@ton-*', '@ton-*/**', 'ton-*', 'tonweb*'],
    message: TON_MESSAGE,
  },
];
const WORKER_ONLY_PATHS = [...TON_PATHS, { name: 'worker', message: WORKER_MESSAGE }];
const WORKER_ONLY_PATTERNS = [
  ...TON_PATTERNS,
  {
    group: [
      'worker/*',
      '**/apps/worker',
      '**/apps/worker/**',
      '../**/worker/src',
      '../**/worker/src/**',
      '../**/worker/dist',
      '../**/worker/dist/**',
    ],
    message: WORKER_MESSAGE,
  },
];

// The two spellings of a CommonJS load: `require(x)` and `module.require(x)`.
const REQUIRE_CALLEES = [
  "[callee.name='require']",
  "[callee.object.name='module'][callee.property.name='require']",
];

const dynamicImport = (re, message) => [
  { selector: `ImportExpression[source.value=/${re}/]`, message },
  // import(`@ton/ton`): a template literal without substitutions is still a constant string.
  {
    selector: `ImportExpression[source.type='TemplateLiteral'][source.quasis.0.value.cooked=/${re}/]`,
    message,
  },
  ...REQUIRE_CALLEES.flatMap((callee) => [
    { selector: `CallExpression${callee}[arguments.0.value=/${re}/]`, message },
    {
      selector: `CallExpression${callee}[arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.cooked=/${re}/]`,
      message,
    },
  ]),
];

// import(x) / require(x) with a computed specifier defeats every static check above, so it is
// refused where the boundary matters. Use a string literal.
const DYNAMIC_MESSAGE =
  'Use a string-literal specifier: a computed import()/require() bypasses the import-boundary rules.';
const NON_LITERAL_LOADERS = [
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: DYNAMIC_MESSAGE,
  },
  ...REQUIRE_CALLEES.map((callee) => ({
    selector: `CallExpression${callee}:not([arguments.0.type='Literal'])`,
    message: DYNAMIC_MESSAGE,
  })),
];

// `require` used as a value instead of being called directly: `const r = require`,
// `require.call(null, '@ton/ton')`, `Reflect.apply(require, ...)`. Each hands the loader to code
// the specifier checks above never see. `require.resolve` / `require.cache` stay allowed.
const REQUIRE_ALIAS_MESSAGE =
  'Call require() directly with a string literal: aliasing it or using .call/.apply/.bind bypasses the import-boundary rules.';
const REQUIRE_ALIAS_SYNTAX = [
  "VariableDeclarator[init.name='require']",
  "AssignmentExpression[right.name='require']",
  "CallExpression > Identifier.arguments[name='require']",
  "ArrayExpression > Identifier[name='require']",
  "MemberExpression[object.name='require'][property.name=/^(call|apply|bind)$/]",
  "MemberExpression[object.name='require'][property.value=/^(call|apply|bind)$/]",
].map((selector) => ({ selector, message: REQUIRE_ALIAS_MESSAGE }));

// `createRequire` (node:module) is a second require() the checks above cannot follow, so the
// whole module is off limits where the boundary matters; getBuiltinModule reaches it too.
const MODULE_RE = String.raw`^(node:)?module$`;
const MODULE_SYNTAX = [
  ...dynamicImport(MODULE_RE, MODULE_MESSAGE),
  { selector: "MemberExpression[property.name='createRequire']", message: MODULE_MESSAGE },
  { selector: "MemberExpression[property.name='getBuiltinModule']", message: MODULE_MESSAGE },
];

const TON_REQUIRE_SYNTAX = [...dynamicImport(TON_RE, TON_MESSAGE), ...REQUIRE_ALIAS_SYNTAX];
const TON_SYNTAX = [...TON_REQUIRE_SYNTAX, ...MODULE_SYNTAX];
const WORKER_ONLY_SYNTAX = [
  ...TON_SYNTAX,
  ...dynamicImport(WORKER_RE, WORKER_MESSAGE),
  ...NON_LITERAL_LOADERS,
];

// pino's `logger.setBindings()` rewrites the bindings printed on every later line and does not
// pass through formatters.bindings or onChild, i.e. it bypasses log redaction. Use
// `logger.child({...})` (redacted by onChild) or pass the fields to the log call.
const SET_BINDINGS_MESSAGE =
  'logger.setBindings() bypasses log redaction; use logger.child({ ... }) or log call fields.';
const SET_BINDINGS_SYNTAX = [
  {
    selector: "MemberExpression[property.name='setBindings']",
    message: SET_BINDINGS_MESSAGE,
  },
  {
    selector: "MemberExpression[property.value='setBindings']",
    message: SET_BINDINGS_MESSAGE,
  },
];

// The reverse direction: apps/worker must not reach into apps/api (it would drag HTTP, bot and
// payment-webhook code into the only process that holds wallet keys). Shared code goes through
// packages/*. The package name of apps/api is "api"; the relative form is `../**/api/(src|dist)`,
// with or without a trailing path (`../../api/src` is the directory index).
const API_RE = String.raw`(^api$|^api\/|apps\/api(\/|$)|^(\.\.\/)+(.*\/)?api\/(src|dist)(\/|$))`;
const API_MESSAGE = 'Do not import from apps/api; share code through packages/*.';
const API_ONLY_PATHS = [{ name: 'api', message: API_MESSAGE }];
const API_ONLY_PATTERNS = [
  {
    group: [
      'api/*',
      '**/apps/api',
      '**/apps/api/**',
      '../**/api/src',
      '../**/api/src/**',
      '../**/api/dist',
      '../**/api/dist/**',
    ],
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
    files: ['apps/api/src/**/*.{ts,mts,cts}', 'apps/worker/src/**/*.{ts,mts,cts}'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: ENV_MESSAGE },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_ENV_SYNTAX, ...SET_BINDINGS_SYNTAX],
      'no-restricted-imports': ['error', { paths: PROCESS_ENV_IMPORTS }],
    },
  },
  {
    // CLAUDE.md §5.7: wallet code and its secrets live in apps/worker only. Closes the
    // bypasses of a plain static `@ton/*` import: dynamic import()/require(), the legacy
    // package names, and reaching into apps/worker by relative path or package name.
    files: [
      'apps/api/**/*.{ts,tsx,mts,cts}',
      'apps/web/**/*.{ts,tsx,mts,cts}',
      'apps/admin/**/*.{ts,tsx,mts,cts}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: WORKER_ONLY_PATHS, patterns: WORKER_ONLY_PATTERNS },
      ],
      'no-restricted-syntax': ['error', ...WORKER_ONLY_SYNTAX, ...SET_BINDINGS_SYNTAX],
    },
  },
  {
    // apps/api (outside config) is under both rule sets above; flat config replaces a rule's
    // options instead of merging them, so the combined set is restated for these files.
    files: ['apps/api/src/**/*.{ts,mts,cts}'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...PROCESS_ENV_IMPORTS, ...WORKER_ONLY_PATHS],
          patterns: WORKER_ONLY_PATTERNS,
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...PROCESS_ENV_SYNTAX,
        ...WORKER_ONLY_SYNTAX,
        ...SET_BINDINGS_SYNTAX,
      ],
    },
  },
  {
    files: ['apps/worker/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: API_ONLY_PATHS, patterns: API_ONLY_PATTERNS }],
      'no-restricted-syntax': ['error', ...API_ONLY_SYNTAX, ...SET_BINDINGS_SYNTAX],
    },
  },
  {
    // Same restating as for apps/api above: the worker (outside config) is under both rule sets.
    files: ['apps/worker/src/**/*.{ts,mts,cts}'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...PROCESS_ENV_IMPORTS, ...API_ONLY_PATHS], patterns: API_ONLY_PATTERNS },
      ],
      'no-restricted-syntax': [
        'error',
        ...PROCESS_ENV_SYNTAX,
        ...API_ONLY_SYNTAX,
        ...SET_BINDINGS_SYNTAX,
      ],
    },
  },
  {
    // packages/* are imported by api, web and admin: a TON import there would put wallet code
    // into every one of them.
    files: ['packages/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: TON_PATHS, patterns: TON_PATTERNS }],
      'no-restricted-syntax': ['error', ...TON_SYNTAX, ...SET_BINDINGS_SYNTAX],
    },
  },
  {
    // Test harness code is never imported at runtime; packages/db/test/global-setup.ts resolves
    // the Prisma CLI through createRequire. Restated because flat config replaces rule options.
    files: ['packages/*/test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: TON_PACKAGE_PATHS, patterns: TON_PATTERNS }],
      'no-restricted-syntax': ['error', ...TON_REQUIRE_SYNTAX, ...SET_BINDINGS_SYNTAX],
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
