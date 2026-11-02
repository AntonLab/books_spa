# Server — books_spa

Express 5 + Sequelize 6 / MySQL API, run as native TypeScript on Node >= 24.

## Topic rules

Read the rule before creating a file or changing a topic you have not read.
Rules live in `.claude/rules/server/`:

| Rule             | Covers                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `api.md`         | Book status, Publication time, Reading and Series order, credits, Genres, zod traps       |
| `access.md`      | ownership, Co-authors                                                                     |
| `visibility.md`  | Notifications, Draft books, comment tombstones                                            |
| `permissions.md` | Roles, the permission matrix, account rank rules                                          |
| `auth.md`        | sessions, login, password reset, CSRF                                                     |
| `rate-limits.md` | sign-in, registration, password, upload and write budgets                                 |
| `images.md`      | Covers and Avatars: storage, `sharp`, the six routes                                      |
| `sequelize.md`   | model typing, MySQL column and foreign-key choices, schema changes                        |
| `testing.md`     | test layers, fakes and contracts, the MySQL-backed suites and their schemas               |
| `seed.md`        | the demo seed                                                                             |
| `operations.md`  | security headers, shutdown, bind errors, expiry purge, announcement pass, Online registry |

## Invariants

Every change holds these; the rules above say why.

- **Identity comes from the session, never the body.** No create schema takes a
  `userId`; controllers read `req.user.id`.
- **`requirePermission` / `requireAuth` run before `validate`**, so a refused
  request answers 401/403, never 400.
- **Ownership checks answer 404 before 403**, so a refusal never confirms an id.
  A book's or series' owner is any of its Co-authors (no owner column exists).
- **Every read that can reach a book takes a `Viewer`** and joins through
  `repositories/visibility.ts`; a Draft book is hidden there, not in a controller.
- **`role` is in neither `createUserSchema` nor `updateUserSchema`**: the update
  schema derives from the create one, so a `role` there would let anyone
  promote themselves.
- **Every write is CSRF-guarded** ahead of every route (`csrfProtection.ts`).
- **Multi-step writes run in one managed transaction**, `{ transaction: t }` on
  every query in it. No string interpolation into `sequelize.query()`; no
  query inside a loop.
- **Throw typed errors** (`types/errors.ts`); `errorHandler`, mounted last, maps
  them to HTTP.
- **Log through `src/logger.ts`**, the one module allowed `console.*`.

## Commands

Scripts are in `package.json`; the traps:

- `dev` restarts on `../shared/src` changes. Do not add `--watch-path`: it
  throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` on Linux.
- `build` omits `*.spec.ts`, `*.testkit.ts` and `src/db/seed/`. `dist/` still
  imports `shared` as `.ts`, so running it needs the workspace link and a
  type-stripping Node (ADR-0006).
- `npm run seed -- --force` **deletes every row in the content tables**
  (`CONTENT_MODELS` in `src/db/seed/seed.ts`), Covers and Avatars with them;
  without `--force` it only reports row counts.
- Keep `--env-file-if-exists` in the `test` script: without it `DB_USER` is
  unset and the MySQL suites fail. `posttest` drops the test schemas, and npm
  runs it only after a green run; never run it by hand. See `testing.md`.

## Environment

`.env.local` (git-ignored) supplies the variables; the full list is the
README's Environment table, and `src/db/config.ts` validates them with zod and
refuses to start on a malformed value. The traps:

- `NODE_ENV` also picks the argon2 cost (`test` is deliberately weak).
- `TRUST_PROXY`: the sign-in limits key on `req.ip`, so set it behind a proxy.
  Production must set it; see README.
- `DB_USER` / `DB_PASSWORD` have no default, so the server never starts against
  an unintended database.
- The test suite alone reads `TEST_DB_NAME` (default `books_spa_test`) and
  `SKIP_MYSQL` (see `testing.md`).

## Runtime

- ESM, and every relative import carries `.ts`: Node resolves imports exactly
  as written, and `rewriteRelativeImportExtensions` turns them into `.js` for
  `dist/`.
- `erasableSyntaxOnly` and `verbatimModuleSyntax`: see
  `.claude/rules/repo/tooling.md`. An ambient `const enum` from a dependency is
  refused too, which is why `password.ts` names no argon2 `algorithm` and
  relies on the argon2id default (`password.spec.ts` pins the PHC prefix).
- `target`/`lib` are `ES2024`; the client and `shared` stay on ES2020.
- `noUncheckedIndexedAccess` and fire-and-forget `void`: see
  `.claude/rules/repo/tooling.md`. A miss may also throw a typed error naming
  what was missing (`itemAt` in `seed/rng.ts`).

## Express 5

Most tutorials and generated snippets are still Express 4:

- **Async errors forward themselves.** A rejected promise from a handler
  reaches `next(err)`; catch only to add context, then rethrow.
- **Handler arity is significant.** An error handler takes exactly four
  parameters. Keep the unused `next` rather than deleting it for a lint rule.
- **`req.query` is a getter with no setter.** Put validated values on your own
  request property, and read it once into a local in a hot path.
- **`app.listen` hands its callback the bind error** (`EADDRINUSE`), which
  Express 4 never did; `index.ts` reports it.

## Layout traps

The directories are what their names say; these are what they do not:

- `src/index.ts` runs `main()` on import, so nothing imports it; `app.spec.ts`
  repeats its startup steps, and a change to startup needs the same change there.
- `repositories/likePattern.ts` is SQL `LIKE` escaping and has nothing to do
  with `likeRepository.ts`.
- `*.testkit.ts` means test support and is never emitted. `src/db/seed/` is not
  test support and carries no such suffix; `tsconfig.build.json` excludes the
  directory instead.
- `types/` holds the zod schemas only; response types, request payloads and
  shared unions are imported from `shared`, so a change to what the API takes
  or returns starts there. `types/payloads.typetest.ts` fails `typecheck` when
  a shared payload no longer fits its route's schema.
