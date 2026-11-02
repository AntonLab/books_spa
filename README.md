# books_spa

[![CI](https://github.com/AntonLab/books_spa/actions/workflows/ci.yml/badge.svg)](https://github.com/AntonLab/books_spa/actions/workflows/ci.yml)
[![CodeQL](https://github.com/AntonLab/books_spa/actions/workflows/codeql.yml/badge.svg)](https://github.com/AntonLab/books_spa/actions/workflows/codeql.yml)

A demo single-page application for browsing books: a React 19 + TypeScript
frontend and an Express 5 + Sequelize/MySQL API, kept in one repository as three
npm workspaces (the third, `shared/`, holds the API types both read).

## Stack

| Layer    | Technology                                                              |
| -------- | ----------------------------------------------------------------------- |
| Frontend | React 19, TypeScript, TanStack Query, React Router 8, antd 6, webpack 5 |
| Backend  | Node.js >= 24, Express 5, Sequelize 6 (MySQL via `mysql2`), zod, argon2 |
| Tooling  | ESLint 9 (flat config), Prettier, Jest (client), `node:test` (server)   |

## Layout

```text
client/   React SPA bundled with webpack 5   — see client/CLAUDE.md
server/   Express API on Sequelize/MySQL     — see server/CLAUDE.md
shared/   API types and string unions both use, .ts source with no build step
```

One root `package.json` declares all three as npm workspaces, so a single
`npm install` at the repo root covers the whole repo and writes one lockfile.

## Prerequisites

- Node.js >= 24 — the LTS line `.nvmrc` names and CI runs; the server runs
  TypeScript directly through Node's native type stripping
- A running MySQL server

## Getting started

```bash
npm install                            # once, from the repo root
cp server/.env.example server/.env.local   # then fill in DB_USER / DB_PASSWORD
npm run dev                            # both, on :3000 and :4000
```

`npm run dev` runs the webpack dev server and the API side by side under
`concurrently`, with each process's output prefixed by name; Ctrl-C stops both.
To run just one, use `npm run dev -w client` or `npm run dev -w server`.

The client dev server proxies `/api` to `http://localhost:4000`, so the browser
only ever talks to one origin in development.

On start-up (outside `NODE_ENV=production`) the server creates the
`books_spa` schema if it is missing and syncs the Sequelize models, so a
clean MySQL install needs no manual setup. `sync()` never alters an existing
table: after a model change, rebuild the dev database with `/db-reset`.

## Environment

`server/.env.local` (git-ignored) supplies the configuration; it is validated
with zod at start-up, so a malformed value fails loudly instead of booting a
broken server.

| Variable                      | Default                    | Notes                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | `development`              | `development` \| `test` \| `production`; also picks the argon2 cost (`test` is deliberately weak) and gates the cookie's `secure` flag                                                                                        |
| `PORT`                        | `4000`                     | The API's port                                                                                                                                                                                                                |
| `DB_HOST` / `DB_PORT`         | `127.0.0.1` / `3306`       |                                                                                                                                                                                                                               |
| `DB_NAME`                     | `books_spa`                |                                                                                                                                                                                                                               |
| `DB_USER` / `DB_PASSWORD`     | _(none)_                   | Required — no default, on purpose. An empty password is accepted, a missing one is not.                                                                                                                                       |
| `APP_BASE_URL`                | `http://localhost:3000`    | Client origin: builds emailed links and is the CSRF trusted origin                                                                                                                                                            |
| `TRUST_PROXY`                 | `0` (none in production)   | Reverse-proxy hops to trust for the client address (`X-Forwarded-For`); `0` trusts none. The sign-in limits key on `req.ip`, so set it behind a proxy. Production must set it explicitly (`0` is valid); boot fails otherwise |
| `MAIL_DELIVERY`               | `log` (none in production) | `log` writes password-reset links and notification emails to the server log; `smtp` sends them. Production must set it explicitly                                                                                             |
| `SMTP_HOST` / `SMTP_PORT`     | _(none)_ / `587`           | Required with `MAIL_DELIVERY=smtp` (port 465 switches to implicit TLS)                                                                                                                                                        |
| `SMTP_USER` / `SMTP_PASSWORD` | _(none)_                   | Required with `MAIL_DELIVERY=smtp`                                                                                                                                                                                            |
| `MAIL_FROM`                   | _(none)_                   | Sender address; required with `MAIL_DELIVERY=smtp`                                                                                                                                                                            |

## API

Everything is mounted under `/api`; the route prefixes are listed in
`server/src/routes/index.ts`.

Authentication is session-based: an opaque token in an httpOnly `sid` cookie,
stored hashed. Every write, plus both reads on `/api/users`, runs through a
five-role permission matrix (`guest`, `user`, `author`, `admin`, `superadmin`)
instead of a blanket session check: a request with no session gets 401, and a
signed-in role with no grant for that action gets 403. Ownership is enforced
on books, series, chapters, comments, likes, favorites and user accounts —
only a row's owner, or an `admin`/`superadmin` acting as moderator, may change
it. Reading lists, library entries and notifications are always the session's
own rows. See
`.claude/rules/server/` — `permissions.md` for the full matrix, `auth.md` for
account blocking, `visibility.md` for the tombstone rules on deleted comments.

Mail goes out through `MAIL_DELIVERY`. With `log` (the default outside
production) password-reset links and notification emails are written to the
server log, so copy a link from there when exercising the flow; with `smtp`
they are sent through the `SMTP_*` settings. Production refuses to start
unless `MAIL_DELIVERY` is set explicitly, so link-logging is never shipped by
accident.

## Scripts

The scripts are in the root `package.json` and each package's own; run the root
ones from the repo root. `build`, `typecheck`, `lint`, `lint:fix` and `test`
fan out over every workspace that defines them; `dev` runs the client and
server together, and every other root script runs once at the root (see the
`scripts` block of the root `package.json`). Target one workspace with npm's `-w` flag (`npm run dev -w client`,
`npm run build -w server`).

`npm run dev` serves the client on :3000 and the API on :4000. `npm run start -w
server` runs the API without the file watcher, and `npm run test:watch -w client`
reruns the client tests on change.

The server's test suite talks to a real MySQL database, so `.env.local` must be
configured before `npm test` there.

## Quality gates

Before committing, run `npm run typecheck`, `npm run lint`,
`npm run format:check` and `npm test` from the repo root. `npm run lint` also
runs `scripts/doc-limits.mjs` and `scripts/check-doc-refs.mjs`; `npm test`
covers every workspace plus the script tests. Commit messages use
conventional-commit prefixes. `npm install` enables the `.githooks/` hooks
(ESLint and Prettier on staged files, a commit-message check, and those two
doc scripts when a `CLAUDE.md` or a rule is staged); they never run
`typecheck` or the tests. `CLAUDE.md` (Quality Gates) holds the full rules.

### Continuous integration

Feature branches start from `dev` and open their PR against it; `dev` is merged
into `main` for a release. Every PR into and push to either branch runs
`.github/workflows/ci.yml` and `.github/workflows/codeql.yml`, and every check
must pass before a PR merges; `.claude/rules/repo/ci.md` lists the jobs and the
branch protection. Dependabot opens weekly update PRs for npm packages and for
the workflows' actions.
