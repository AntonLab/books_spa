---
name: db-reset
description: Drop the local dev database and rebuild it with the demo seed. Use after a model change, since sync() never alters an existing table.
disable-model-invocation: true
---

# Reset the dev database

`sequelize.sync()` creates a missing table and never alters an existing one
(ADR-0016), so a changed model needs a dropped database. The seed recreates it:
it runs `ensureDatabase` and then `sequelize.sync()` before inserting
(`server/src/db/seed/seed.ts`).

Both steps destroy every row in the dev database. Say so and wait for the user
to confirm before step 1; the project settings also ask before any seed run.

1. Drop, from `server/` (reads `.env.local` through the server's own config,
   refuses `NODE_ENV=production`):

   ```sh
   node --env-file-if-exists=.env.local --input-type=module -e "import mysql from 'mysql2/promise'; import { loadConfig } from './src/db/config.ts'; const { env, db } = loadConfig(); if (env === 'production') throw new Error('db-reset refuses production'); const c = await mysql.createConnection({ host: db.host, port: db.port, user: db.username, password: db.password }); await c.query('DROP DATABASE IF EXISTS ??', [db.database]); await c.end(); process.stdout.write('dropped ' + db.database + '\n');"
   ```

2. Rebuild and seed, from the repo root:

   ```sh
   npm run seed -w server -- --force
   ```

3. Report the row counts the seed printed. A running `npm run dev` server keeps
   a pool to the dropped schema; tell the user to restart it.
