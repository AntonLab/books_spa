---
paths:
  - 'server/src/db/seed/**'
---

# Demo seed

## Accounts

All accounts share the password in `DEMO_PASSWORD` (`seed.ts`) and are `active`
except two; names are real on purpose because the UI shows them ("User Two"
answering "User Four" reads as a test run, not a demo). Personas are in
`db/seed/personas.ts`.

- `blocked1` (Blocked, `author`) co-authors the first standalone Published book
  beside an Active author, writes one Comment on it and owns one Reading list
  holding it. Its activity is fixed, added after every random draw in
  `buildPlan`, so it never shifts the rest of the demo. It exists so the UI has
  a name that renders without a link.
- `pending1` (Pending, `user`) owns nothing. Plan steps that give every
  `user` content (Library, Favorites, Reading lists) run before it exists.

## Rules that keep the data honest

- **It writes through the models, not the API**, since registration cannot mint
  an admin. Payloads still pass the routes' zod schemas; only the fields those
  withhold (Co-authors, role, status) are attached afterwards. `genreId` goes
  through the schema with the rest.
- **Accounts use `create()`, everything else `bulkCreate()`.** `bulkCreate`
  skips `User.beforeSave` and would store the password in clear. Comments go
  one thread level at a time, because a reply needs its parent's id and MySQL
  back-fills bulk ids from the first; `writeThreads` throws on a missing id.
- **Dates anchor to the run**: the newest chapter is always 2-5 days old, the
  cadence scales to `PUBLICATION_WINDOW_DAYS`, `createdAt` is passed
  explicitly, and `{ silent: true }` keeps a backdated `updatedAt`.
- **Everything already out is announced** (`announcedAt` = the run's start) on
  books and chapters, or the first announcement pass would mail every Favorite
  holder about the catalogue. Scheduled chapters and Draft books stay
  unannounced, so the pass announces them when their time comes.
- The data never shows what the API would refuse: no like on one's own book or
  comment, none on a tombstone or Draft book, no Favorite on a Draft book or on
  a series with no non-draft book, no activity before an account's
  `createdAt`, no Notification that contradicts a byline.
- A content bank (`ContentBank`: `GOTHIC`, `HARD_SF`, `URBAN_FANTASY`) supplies
  each author's titles, tags and prose. The seed writes a two-level Genre tree
  (`GENRE_TREE`). A bank's `genreName` is typed `SubgenreName`, so it cannot
  name a Genre the seed never creates; even-numbered works (counted per author,
  no RNG draw) sit under that Subgenre, odd-numbered ones under its parent.
  Mystery and most Subgenres stay empty on purpose, to demo an empty Genre.

## Deleting

- Tables are deleted in the explicit order of `CONTENT_MODELS` in `seed.ts`
  (children before parents), not by leaning on cascades that could change; a
  new table joins that list.
  Covers and Avatars go by cascade with `books`/`users`. `permissions` is left
  alone: `syncPermissions()` derives it from code.
- The delete and every insert share one transaction; a failure leaves the
  previous demo intact.
- Guards (`seedGuards.ts`): `NODE_ENV=production` is refused regardless of
  flags; a `DB_NAME` other than `books_spa` gets a loud warning.

## Tests

`plan.spec.ts` needs no database; nothing under `seed/` except `seed.ts` runs
on import. `seed.spec.ts` runs the script as a child process on a schema of its
own.
