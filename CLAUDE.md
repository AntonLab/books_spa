# Claude Code — books_spa

Three npm workspaces under one root `package.json`: a webpack-bundled React
(TypeScript) frontend, an Express + Sequelize backend, and the API types both
of them read.

## Layout

- `client/` — React 19 SPA. See `client/CLAUDE.md`.
- `server/` — Express 5 + Sequelize/MySQL API. See `server/CLAUDE.md`.
- `shared/` — API response types, request payloads, field limits and string
  unions, as TypeScript source with no build (ADR-0006). The client reads
  responses through `Wire<T>`; relative imports carry `.ts` and only erasable
  syntax is allowed. Each union derives from an `as const` array that the
  server's zod schemas or Sequelize `ENUM`s also build from; no zod schema
  lives here, so zod never reaches the client bundle.
- `.claude/rules/` — topic rules for Claude Code, split by `server/`,
  `client/` and `repo/`. Each loads only when Claude Reads a file its `paths:`
  frontmatter names (a Write or Edit does not trigger it; subagents get them
  too); each package's CLAUDE.md indexes its own.
- `tsconfig.base.json`, `eslint.config.base.mjs` — the shared compiler options
  and flat-config core every package extends (see `.claude/rules/repo/tooling.md`).

One `npm install` at the root installs every workspace into one hoisted
`node_modules`. Dependencies stay declared in the package that uses them.
`node_modules/shared` is a link, not a copy, and must stay one: Node strips
types only from a file whose real path lies outside `node_modules`.

## Stack

- Node.js >= 24 (`.nvmrc`, CI and `engines.node` agree; `@types/node` follows
  its major).
- Frontend: React 19. Backend: Express 5, Sequelize 6 (MySQL via `mysql2`).

## Status

- **Schema comes from `sequelize.sync()`, which never alters a table.** After a
  model change, drop and rebuild the dev database (`/db-reset`); see
  `.claude/rules/server/sequelize.md` and ADR-0016.
- `npm run seed -w server -- --force` loads the demo data. **The flag is
  mandatory and destructive** — see `server/CLAUDE.md`.

## Quality Gates

Run from the repo root before commit; each fans out over every workspace
(`-w client` targets one):

- `npm run typecheck`
- `npm run lint` (`npm run lint:fix` applies fixes); it also runs
  `scripts/doc-limits.mjs` and `scripts/check-doc-refs.mjs`
- `npm run format:check` (`npm run format`) — Prettier is root-only; no package
  defines a format script.
- `npm test` — every workspace, then `test:scripts` (`scripts/test/*.test.mjs`). A green server run drops its test schemas through
  `posttest`; a red one leaves them for inspection.

The pre-commit and commit-msg hooks are described in
`.claude/rules/repo/tooling.md`; `git commit --no-verify` bypasses both.

CI (`.github/workflows/`) gates every PR into `dev` or `main`; see
`.claude/rules/repo/ci.md` before renaming or adding a job.

## Anti-Patterns

- Absolute local paths in checked-in governance files. Use relative paths.
- Documenting a command, script or dependency that `package.json` lacks.
- **Growing a CLAUDE.md.** Keep each at 200 lines or fewer and each rule at 150;
  `scripts/doc-limits.mjs` fails `lint` and the pre-commit hook above that.
  A new trap goes into the `.claude/rules/` file for its area, or a new one
  with `paths:` naming the files it concerns, and gets a row in that package's
  index. Write down what does not follow from the code — traps, rationale,
  conventions that differ from the default — and leave inventories to the
  directory tree and history to git.
- `console.log` in production code (the server logs through `src/logger.ts`).
- The `setup-pre-commit` skill, Husky or lint-staged: they install a competing
  hook.
- `any` (use `unknown` or a real type); `@ts-ignore` (use `@ts-expect-error`
  with a reason); `enum` (use `as const`). Lint and `erasableSyntaxOnly`
  refuse all three.
- Class components (lint allows only the client's `ErrorBoundary`, since
  React has no hook for `getDerivedStateFromError`) and sync calls such as
  `readFileSync` in server code outside tests (lint refuses them).

Judgement-call rules live in `CODING_STANDARDS.md`. Only the task and final
reviewers read it; implementers do not, so a rule there costs no context.

## Security

- No hardcoded secrets — grep for `sk_live`, `AKIA`, `password=` before commit.
  DB credentials live in `.env.local` (git-ignored).
- Every write is CSRF-guarded on the server (Origin / `Sec-Fetch-Site` plus a
  session-bound `X-XSRF-Token`), and the client's `request()` sends the token.
  Route new writes through `request()`.

## Workflow

1. Work within one package and read its CLAUDE.md. A change to what the API
   returns starts in `shared/`.
2. Name domain things the way `CONTEXT.md` does; check `docs/adr/` before
   contradicting a recorded decision.
3. Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`,
   `test:`, `ci:`).
4. Branch from `dev` and open the PR against `dev`; `main` only receives `dev`.
   Run `npm run branch:check` before starting work, before opening a PR and
   before pushing another commit to an open PR's branch.

## Agent skills

- **Issues**: GitHub issues on `AntonLab/books_spa` through `gh`. See
  `docs/agents/issue-tracker.md`.
- **Triage labels**: five canonical roles, label equal to name. See
  `docs/agents/triage-labels.md`.
- **Domain docs**: one `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
- **Project skills**: `npm run skills` restores them after a fresh clone or a
  lock change. See `.claude/rules/repo/skills.md`.
- **Plugins**: `.claude/settings.json` enables superpowers, mattpocock-skills,
  code-review, ponytail, caveman and swarm (mandatory). Accept the install prompt on a
  fresh clone. See `.claude/rules/repo/claude-config.md`.

### Context-saving agents

Dispatch is a recommendation: choose inline or a subagent by which costs fewer
tokens at the same quality. A subagent pays for itself when its output is large
and the main session needs only the verdict.

- **`repo-auditor`** (Sonnet, read-only) takes any "check / audit / find all"
  request, `/ponytail-audit` included, and returns numbered findings. Grilling
  and the question of which findings to fix stay in the main session. The
  picked findings go into a brief file for `sdd-implementer`. Each declined
  finding gets a line in `docs/agents/rejected-findings.md`, with the user's
  reason, so later audits skip it.
- **`gate-runner`** (Haiku) runs the quality gates or reads a CI run and
  returns only the failures. Prefer it to running the gates inline, which
  floods the main context with passing output. The `guard-shell` hook blocks an
  unbounded package-wide gate in the main session; a focused test or a gate
  piped through `| tail` passes.
- **`ui-checker`** (Sonnet, no edits) checks pages and flows in the browser
  through the Playwright MCP and returns pass/fail per item. Prefer it after
  a UI change and for a PR test plan's manual items: its calls and DOM dumps
  stay out of the main context, but its cost grows with every call, so give it
  a short list. One quick look inline (a snapshot, a screenshot) is fine when
  a single check settles the question. It never deletes, edits, blocks or bans
  seed records: a destructive check acts on a record it created first.
- **Prefer `Explore` or `caveman:cavecrew-investigator` for broad search**:
  `general-purpose` runs on Sonnet and loads the full context. A direct Grep
  or Read is cheaper when the file is known. While a plan pipeline runs,
  `code-mapper` and `sdd-implementer` are the default for mapping and changes;
  `cavecrew-builder` and the search agents do not replace them.
- The agents come from the `swarm` plugin: dispatch them as `swarm:<name>`
  (`swarm:code-mapper`). Every agent preloads `caveman`
  (`.claude/rules/repo/claude-config.md` has the detail).
- To find out why a pipeline session went wrong, use
  `superpowers:diagnosing-superpowers` rather than reading transcripts by hand.

### UI checks and focused tests

`swarm:ui-checker` and `swarm:sdd-re-reviewer` read these values here; without
them `ui-checker` reports `BLOCKED`.

- **UI-check server:** ports 3100 (client, the one the browser opens) and 4100
  (API). Start from the worktree:
  `PORT=4100 APP_BASE_URL=http://localhost:3100 npm run dev`; both the client
  config and the server read these two variables. Ports 3000 and 4000 are the
  user's own dev server: never stop it.
- **Database:** MySQL. If the server cannot reach it, report `BLOCKED`; never
  run `seed` or `/db-reset`.
- **Seeded logins:** `superadmin`, `admin`, `mhale`, `ipetrov`, `nquinn`,
  `user1`–`user5`, plus the non-Active `blocked1` and `pending1`. They share
  the password in `DEMO_PASSWORD` (`server/src/db/seed/seed.ts`). Roles:
  `USER_ROLES` in `shared/src/role.ts`.
- **Focused test commands:** client `npm test -w client -- <test path>`;
  server, from `server/`,
  `node --env-file-if-exists=.env.local --test <spec path>`
  (`npm test -w server -- <path>` still runs the whole glob); root scripts
  `npm run test:scripts`.

### Shell on Windows

Every session runs Git Bash on Windows, so commands are POSIX:
`cd "D:/path" && …` with forward slashes (a backslash path loses its
separators; `cd /d` is cmd.exe), `head`/`tail` in Bash only. Create and change
files only with `Write`/`Edit`: a heredoc breaks on the first unmatched quote,
and `sed -i`, `cp`, `>` or a `node -e` rewrite skip the Prettier hook. `Edit`
needs the file `Read` first; a Bash `cat` or `sed -n` does not count. List a
directory with `Glob`, since `Read` on one fails with EISDIR; when `Grep` fails
with `EPERM ... uv_spawn 'rg'`, fall back to `git grep`.

### Plan pipeline agents

Plan pipeline: **Read `.claude/rules/repo/pipeline.md` before running it**; it
does not load itself. Save the spec before dispatching `plan-writer`. Prefer
one spec per main session (`/clear` after its PR). Pass `model` on every dispatch,
opus only when the user asks. Before a brief or an issue states a fact, run its
command: `.claude/rules/repo/claims.md`.
