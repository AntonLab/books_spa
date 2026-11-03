---
paths:
  - 'server/src/**/*.spec.ts'
  - 'server/src/**/*.testkit.ts'
---

# Server tests

## Layers

Each answers a question the others cannot:

- **Unit specs** run a module against doubles. Capture log output with
  `t.mock.method(logger, level, …)`. `errorHandler.spec.ts` pins the redaction
  rules: a parse failure's body is never echoed or logged, a 500 logs only
  name/message/stack.
- **Repository specs** run on MySQL and are the only place domain rules are
  proven (Draft visibility, the last Co-author, credits, Notifications, reorder
  409s, tombstones, rank, Cover/Avatar cascade).
- **Route specs** run `createApp` on in-memory fakes
  (`repositories/<name>Repository.fake.testkit.ts`) and assert the HTTP mapping
  and permission checks. A fake takes its seeds and spies as one options
  object and never grows a domain rule: a rule copied into it is a second
  implementation that can drift from the SQL one while every route spec stays
  green, so Draft visibility and the like are proven on MySQL only. Session,
  reset and notification fakes stay inline in their route specs. Shared harness:
  `routes/routeTestKit.testkit.ts`.
- **Contracts** (`<name>Repository.contract.testkit.ts`) run twice, on MySQL
  from `<name>Repository.spec.ts` and on the fake from `.fake.spec.ts`. They
  assert interface semantics only: `null`/`false` for a missing row, which
  error and which resource a `NotFoundError` names, an order a controller
  relies on. The one domain rule in a contract is a Genre name's
  case-insensitive uniqueness, because the fake has to reproduce what MySQL
  gets from the collation. A repository method a controller comes to rely on
  belongs in its contract. `chapterRepository.findCoAuthorIds` has no
  `ORDER BY`, so its contract compares a set.
- **`src/app.spec.ts`** is the one suite from HTTP through real repositories to
  MySQL, on its own `_app` schema. It takes its repositories from
  `createSequelizeRepositories()` as `index.ts` does, but repeats the boot
  steps around them (`initModels`, `sync`, `syncPermissions`), so a change to
  those needs the same change there. Its admin comes from `User.create`, since
  no API makes one.

## MySQL-backed suites

- Each asks `skipWithoutMysql()` (`db/mysqlProbe.testkit.ts`) whether to run:
  with `DB_USER` unset or MySQL unreachable it throws, failing the spec file
  with the reason. `SKIP_MYSQL=1` turns that failure into a skip, and makes
  `posttest` skip its cleanup. A new suite takes its `skip` from this helper,
  or a missing database passes it silently.
- `node:test` runs spec files in parallel processes, and two suites calling
  `sync({ force: true })` on one schema drop each other's tables. So each suite
  has its own schema, named `TEST_DB_NAME` (default `books_spa_test`) plus
  `_<suite>`. `posttest` (`db/dropTestDatabases.testkit.ts`) drops everything
  under that prefix after a green run; a red run leaves the rows for
  inspection. A schema named any other way stays on disk forever.
- A suite that syncs calls `initModels`, not a single `init*Model`, or `sync`
  cannot work out the drop order.
- MySQL will not `TRUNCATE` a referenced table, so suites clear with
  `destroy({ where: {} })`, children first: `Like` → `Comment` → `Chapter` →
  `Book` → `Series` → `User`. `Comment` goes explicitly and before `User`,
  because `comments.userId` is `SET NULL` and would leave orphans. A suite that
  counts notifications clears `Notification` first.
- Create works through `createCreditedBook` / `createCreditedSeries`
  (`models/creditedBook.testkit.ts`), which write the credits beside them. A
  book is `in_progress` unless the fixture names a status, because a draft
  would hide the rows most suites read back.
