// Flat ESLint config (ESLint 9).
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/out-tsc/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/.vscode-test/**',
      '**/.fuzzwork/**',
      'coverage/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2021,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // --- Dead / unused code: the main thing we want to catch. Errors (not
      // warnings) so `eslint .` fails CI on an unused var, import, or function. ---
      'no-unused-vars': 'off', // superseded by the type-aware-friendly version below
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // --- Correctness rules (the bug-catching subset of eslint:recommended;
      // listed explicitly to avoid pulling in @eslint/js as a dependency). ---
      'no-unreachable': 'error', // code after return/throw/break/continue
      'no-fallthrough': 'error', // missing break in a switch case
      'no-dupe-keys': 'error', // duplicate object literal keys
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-cond-assign': ['error', 'except-parens'], // allow the `while ((m = re.exec()))` idiom
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }], // intentional `catch {}` is fine
      'no-empty-pattern': 'error',
      'no-sparse-arrays': 'error',
      'no-irregular-whitespace': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'for-direction': 'error',
      'getter-return': 'error',

      // --- Light style/safety rules that prevent real bugs. ---
      'prefer-const': 'error', // a `let` that is never reassigned is usually a mistake
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // Type-aware pass over source files only (tests/scripts excluded to avoid
    // tsconfig project-membership friction). Catches usage of any `@deprecated`
    // symbol — e.g. a VS Code API deprecated in a release we now type against,
    // since we float @types/vscode to latest while pinning engines.vscode to the
    // supported floor.
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: ['packages/*/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
];
