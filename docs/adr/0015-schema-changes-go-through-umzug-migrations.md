---
status: superseded by ADR-0016
date: 2026-10-17
---

# Schema changes go through Umzug migrations

Every schema change is a model change plus a new migration, run by Umzug 3 with
`SequelizeStorage` (the applied names live in the `SequelizeMeta` table). Until
now `sequelize.sync()` was the only schema path: it creates a missing table and
never alters an existing one, and production does not run it at all, so a
deployment had no way to build or change its schema.

The baseline is one migration of raw DDL that builds every table. Migrations are
`up` only: a rollback is a new migration, because a `down` for a destructive
change is code nobody runs until the day it is wrong. Boot migrates outside
production. In production it only asserts that nothing is pending and refuses to
start otherwise; production migrates with `npm run migrate -w server` before the
server starts. The seed migrates too, so it builds the same schema a deployment
does. Test schemas stay on `sync({ force: true })`, which is fast and isolated
per suite, except the two seed suites in `seed.spec.ts`, which build theirs with
the migrations. A parity spec compares a `sync()` schema with a migrated one, so the two cannot
drift apart unnoticed.

## Considered Options

- **`sequelize-cli`.** Rejected: its defaults are CommonJS and it has no
  TypeScript support, and the server is ESM running TypeScript directly.
- **A generator script that diffs the models and writes migrations.** Rejected:
  a one-off tool for a schema this size, and generated DDL still needs a human
  review.
- **Detect "tables exist" and mark the baseline applied.** Rejected: a database
  built by an older `sync()` may differ from the baseline, and the guess would
  hide that drift.
- **A seed that tolerates existing tables.** Rejected for the same reason: it
  would seed into a schema no migration produced.

## Consequences

- Existing dev databases are rebuilt once with `/db-reset`. After that a schema
  change reaches them by a migration.
- The parity spec fails when a model and the migrations disagree, so a model
  edit without its migration (or the reverse) turns CI red.
- Umzug takes no lock. Two instances migrating at once could both run the same
  migration, so one instance migrates at a time, which fits the single-instance
  deployment of ADR-0013.
- The baseline's `CREATE TABLE` statements are MySQL DDL, which is not
  transactional, so a failure partway leaves some tables and no `SequelizeMeta`
  row. The next `up()` then fails with "table already exists". Recovery:
  `/db-reset` in development; in production, drop the partial tables by hand and
  rerun `npm run migrate -w server`. `IF NOT EXISTS` is not used on purpose,
  because it would hide drift.
- The XOR `CHECK` constraints on `likes` and `favorites`, which Sequelize 6
  cannot declare, are migration `0003-xor-checks.ts`.
