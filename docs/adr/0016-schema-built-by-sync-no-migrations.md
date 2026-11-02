---
status: accepted
date: 2026-11-02
---

# Schema is built by `sync()`, with no migrations

Boot and the seed call `sequelize.sync()`, which creates a missing table and
never alters an existing one. A model change reaches a database by dropping and
rebuilding it (`/db-reset`). This supersedes ADR-0015.

The project is a local demo seeded from code, so no database holds data worth
keeping across a schema change, and there is no production deployment. Umzug,
the baseline, the parity spec and the production "no pending migrations" check
cost more to maintain than a reset costs to run.

## Considered Options

- **Keep the Umzug migrations (ADR-0015).** Rejected: the machinery guards data
  and deployments this project does not have.
- **`sync({ alter: true })`.** Rejected: it rewrites tables unpredictably and
  can drop columns or indexes silently.
- **Keep the XOR `CHECK`s with a raw `ALTER TABLE` after `sync()`.** Rejected:
  code to protect a demo from a state the zod `.refine()` and the model
  `validate` already refuse.

## Consequences

- Every model change needs `/db-reset`. Existing rows are lost.
- `likes` and `favorites` lose the database `CHECK` that required exactly one
  target. Only the application enforces it; a write that bypasses the models
  could store both or neither.
- The `ON UPDATE RESTRICT` that the `CHECK` forced on those foreign keys
  (errno 3823) is no longer required.
- Revisiting this means writing a baseline migration again, and a real
  deployment would need that first.
