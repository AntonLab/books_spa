---
paths:
  - 'tsconfig.base.json'
  - '**/tsconfig*.json'
  - 'eslint.config.base.mjs'
  - '**/eslint.config.mjs'
  - 'package.json'
  - '*/package.json'
  - '.githooks/**'
  - 'scripts/**'
  - '.prettierrc.json'
  - '.prettierignore'
---

# Shared tooling

## `tsconfig.base.json`

- Every package's `tsconfig.json` extends it by relative path.
- It sets `noUncheckedIndexedAccess` for all three packages: an index read is
  `T | undefined`, application code handles the miss, and only test files
  assert it away with `!`.
- Fire-and-forget: await a promise, or mark a deliberate one `void` with the
  reason beside it (`onFinish={(values) => void handleFinish(values)}`). The
  typed lint rules take no `eslint-disable`.
- `erasableSyntaxOnly` and `verbatimModuleSyntax` hold everywhere, because
  Node strips types from the server and `shared` (ADR-0006); the client keeps
  the same rules so code moves between packages unchanged.
- Left off on purpose: `noPropertyAccessFromIndexSignature` and
  `exactOptionalPropertyTypes`, each a hundred-odd edits for little caught.
- Keep `include`, `exclude` and `paths` out of it: TypeScript resolves them
  against the declaring file, so they would point at the repo root.

## `eslint.config.base.mjs`

- Exports `createConfig({ ignores, tsconfigRootDir }, ...packageConfigs)`,
  built with ESLint's `defineConfig`. Each package's own `eslint.config.mjs`
  calls it with `import.meta.dirname`, because ESLint does not search parent
  directories.
- The `**/*.{ts,tsx}` block turns on typed linting (`projectService`) for four
  rules: `no-floating-promises` (node:test's `test`/`describe`/`it`/`suite`
  exempt), `no-misused-promises`, `await-thenable` and
  `switch-exhaustiveness-check` (a `default:` does not cover a missing union
  member: write the `case`). JavaScript stays untyped. Growing this toward
  `recommendedTypeChecked` is a deliberate step, one measured rule at a time.
- `no-duplicate-imports` allows one `import type` line beside the value import
  from the same module, the repo's style.
- `no-console` and `no-non-null-assertion` are errors; test files
  (`*.spec.ts`, `*.test.ts(x)`, `*.testkit.ts`, `src/test/`) may write `!`.
- The client config adds the rules `client/CLAUDE.md` lists;
  `no-restricted-imports` takes one option set per file, so each level block
  repeats the rules above it.
- Root devDependencies hold `@eslint/js`, `eslint-config-prettier` and
  `typescript-eslint`; `client/package.json` holds the React, react-hooks and
  jsx-a11y plugins `client/eslint.config.mjs` imports. npm hoists them.

## Root `package.json`

Owns the devDependencies every package needs. `fallow` is installed for
audits (`repo-auditor` uses it with the `fallow` skill).
`shared/src/wire.typetest.ts` pins `Wire<T>` with type-level assertions that
`typecheck` checks.

Root `overrides` pins `uuid` to `11.1.1` for GHSA-w5hq-g745-h8pq, because
`sequelize` 6 pulls an older `uuid` (8.x). Drop the override once `sequelize`
ships `uuid` >= 11.1.1. `braces` (via
`webpack-dev-server`) has no patched release, so it carries no override.

## Pre-commit hook (`.githooks/pre-commit`)

- Runs ESLint `--fix` per package, from inside it (flat config does not
  cascade, and that is what points typed linting at the package's tsconfig),
  routed by the staged path's `client/`, `server/` or `shared/` prefix. Then
  Prettier `--write` once from the root over every staged file. Re-stages what
  they rewrote; blocks on a surviving ESLint error; warnings pass.
- Refuses a partially staged file, since re-staging the rewritten copy would
  pull its unstaged hunks into the commit.
- If `node_modules/.bin` is missing it warns and lets the commit through.
- `core.hooksPath` is per-clone; the root `prepare` script sets it
  (`git config core.hooksPath .githooks` by hand).

## Commit-msg hook (`.githooks/commit-msg`)

Checks the subject against `^(feat|fix|refactor|chore|docs|test|ci)(\(scope\))?!?: `,
the types the root CLAUDE.md lists; add a type to both at once. Git's own
`Merge …` and `Revert "…"` subjects and `fixup!`/`squash!`/`amend!` pass.

## `.npmrc`

`engine-strict=true`: npm refuses to install on a Node below `engines.node`.

## `scripts/`

Plain Node (`*.mjs`) and one Bash script, with no dependencies; Prettier
checks the `.mjs` files, but no package's ESLint config reaches them. CI's
`lint` job syntax-checks every `scripts/*.mjs` with `node --check` (syntax only,
no lint rules). Their tests sit in `scripts/test/` and run through
`npm run test:scripts` (part of `npm test` and CI's `lint` job); a script that
runs on import keeps its testable part in a sibling module, as `worktree.mjs`
does with `remove-dir.mjs`.
CI runs them on Linux, where `path` is POSIX and `\` is no separator: a check
on a path or name holds for `path.posix` and `path.win32` alike, and its test
covers both separators.
`doc-limits.mjs` holds CLAUDE.md files to 200 lines and rules to 150.
`check-doc-refs.mjs` fails on a backtick identifier in CLAUDE.md or a rule that no tracked file spells, or a file name or path that is no tail of a tracked path (`git ls-files`). Allowlist: `doc-refs-allowlist.txt`; an entry no doc uses fails too.
It runs in `npm run lint` after `doc-limits` and in the pre-commit hook.
`brief-check.mjs` (`npm run brief:check -- <brief.md>`) prints a `git grep`
hit count per name, using `extractTokens` from `doc-refs.mjs`; the logic is in
`brief-refs.mjs`.
`sdd-step.sh` finds the superpowers scripts by globbing the plugin cache for
the newest version, so it needs no update when the plugin does.
`layout-lint.mjs` (`npm run layout-lint`) is the one script with a dependency,
`playwright-core`. It drives the installed Edge or Chrome at 375px against a
running dev server and fails on an element outside the viewport or a word
broken mid-line; it needs `LAYOUT_LINT_PASSWORD` (the seed's `DEMO_PASSWORD`)
and keeps its in-page rules in `layout-lint-rules.mjs`, tested in a real
browser (skipped, with the launch error logged, where no Edge or Chrome
launches; fails under `CI`).
`plan-check.mjs` tells a test block from implementation by a `test`/`it`/
`describe`/`expect` call; a plan whose tests use another runner's names needs
the pattern widened, not the 15-line limit. It also caps a task at
`MAX_TASK_LINES` (180); a longer task becomes two.
