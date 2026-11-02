/**
 * Shared ESLint config for every workspace.
 *
 * ESLint does not search ancestor directories for a flat config: run from
 * `client/` with no local config it reports "File ignored because no matching
 * configuration was supplied". So each package keeps its own
 * `eslint.config.mjs`, which calls `createConfig` from here. The package
 * configs set their own `languageOptions` (browser globals and ES2020 vs Node
 * globals), and the client config also adds rules (see `client/CLAUDE.md`).
 *
 * The plugins are imported by bare specifier; `.claude/rules/repo/tooling.md`
 * says where each is declared.
 *
 * .ts and .tsx files are linted with type information: the project service
 * reads the tsconfig.json nearest each file (the client's webpack config has
 * its own), hence the `tsconfigRootDir` each package passes. JavaScript files
 * (jest.config.mjs, the eslint configs themselves) are never parsed with types.
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The repo-wide anti-patterns from CLAUDE.md, applied to every package.
const sharedRules = {
  'no-console': 'error',
  // The repo writes types on their own `import type` line beside the value
  // import from the same module; that pair is not a duplicate.
  'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
  // noUncheckedIndexedAccess types a miss as undefined; application code
  // handles it. Tests may assert it away (the override below).
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

// A few typed rules rather than the whole recommendedTypeChecked preset: the
// promise mistakes the untyped rules cannot see, and a switch over an
// `as const` union (the repo's enum) that misses a member. node:test's `test`,
// `describe`, `it` and `suite` return promises the runner itself tracks, so
// they are exempt — typescript-eslint's documented form for that API.
const typedRules = {
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  '@typescript-eslint/no-floating-promises': [
    'error',
    {
      allowForKnownSafeCalls: [
        {
          from: 'package',
          package: 'node:test',
          name: ['test', 'describe', 'it', 'suite'],
        },
      ],
    },
  ],
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
};

/**
 * @param {{ ignores?: string[], tsconfigRootDir: string }} options
 *   `ignores`: the calling package's own build-output directories (`build`
 *   or `dist`). `tsconfigRootDir`: the calling package's directory — pass
 *   `import.meta.dirname` — where the project service finds its tsconfig.
 * @param {...object} packageConfigs  config objects specific to the calling
 *   package; they are spliced in before the Prettier tail.
 */
export const createConfig = (
  { ignores = [], tsconfigRootDir },
  ...packageConfigs
) => {
  if (typeof tsconfigRootDir !== 'string') {
    throw new Error(
      'createConfig needs tsconfigRootDir: pass import.meta.dirname from the package eslint.config.mjs'
    );
  }

  return defineConfig(
    { ignores: ['coverage', 'node_modules', ...ignores] },
    js.configs.recommended,
    tseslint.configs.recommended,
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: { ...sharedRules, ...typedRules },
    },
    {
      files: [
        '**/*.{spec,test}.{ts,tsx}',
        '**/*.testkit.ts',
        'src/test/**/*.{ts,tsx}',
      ],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    ...packageConfigs,
    // Disables stylistic rules that conflict with Prettier. Must stay last,
    // which is why this helper appends it instead of leaving it to each caller.
    prettier
  );
};
