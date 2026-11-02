---
paths:
  - 'server/src/models/**'
  - 'server/src/repositories/**'
  - 'server/src/db/**'
---

# Sequelize and MySQL

## Models

- Attributes come from `InferAttributes` / `InferCreationAttributes`,
  server-generated columns are `CreationOptional`, and every field is
  `declare`d, or it emits a class property that shadows Sequelize's accessor.
- The dialect is MySQL: `DataTypes.JSONB` and `DataTypes.ARRAY` do not exist
  here.
- Tables are `utf8mb4` / `utf8mb4_0900_ai_ci`; MySQL's `utf8` is 3-byte and
  drops emoji. Past `VARCHAR(255)`, index with a prefix.
- **`login` is `utf8mb4_0900_as_cs`**, given as a raw type string because
  Sequelize 6 has no per-column collation, so `Bob` and `bob` are two Accounts.
  `email` is `utf8mb4_0900_as_ci` (case-insensitive, accent-sensitive),
  declared as a raw type string like `login`. A query matching `login`
  alongside such fields needs an explicit `COLLATE`, and so does an admin
  search that must ignore accents in `email`: both go through
  `COLLATE utf8mb4_0900_ai_ci` (`buildWhere` in `userRepository.ts`).
- Uniqueness is a unique index, never a validator running `findOne` first.
- A hook passes `options.transaction` to every query it runs. External side
  effects stay out of hooks: `afterCreate` fires before commit, and a rollback
  cannot unsend an email.
- A failed `sequelize.authenticate()` stops the process.

## Columns

- `tags` are `JSON` columns: a JSON column takes no literal `DEFAULT`, so the
  `[]` default lives in the create schemas. Membership is `JSON_CONTAINS`, never
  `LIKE` (`?tag=epic` would match `epic-fantasy`), with the tag passed as an
  argument to `fn()`.
- `chapters.text` is `MEDIUMTEXT`: `TEXT` is 65,535 bytes, ~16k characters in
  utf8mb4. `CHAPTER_TEXT_MAX_LENGTH` (1,000,000) fits even at 4 bytes each.
- `chapterRepository.list` omits `text` and returns `ChapterSummary`; the
  omission sits in the type so no call site puts it back.
- `chapters.wordCount` is `countWords(text)`, written by a setter on `text` in
  `Chapter.ts`, not by a hook: `bulkCreate` (the seed) runs setters but skips
  per-instance hooks, and `instance.update` saves the side effect. So every
  write that assigns `text` recounts, and one that does not leaves it. It is
  summed into `BookDetail.wordCount` and never sent per chapter.
- Credits are ordered by surrogate `id`, not `createdAt`: whole-second
  `DATETIME` ties two credits added in one second.
- `book_covers` / `user_avatars` keep `updatedAt` and drop `createdAt` (replaced
  in place); `book_authors` / `series_authors` do the reverse (never edited).

## Foreign keys

- Types match exactly: every id is `INTEGER UNSIGNED`, and a plain `INTEGER`
  referencing one fails with errno 3780.
- Credits live in two tables, not one polymorphic `credits`, so each keeps a
  real foreign key. Both `CASCADE`; whether a work goes with its last credit is
  `userRepository.remove`'s decision.
- `books.seriesId` is nullable, `SET NULL`: dropping a series unlinks its
  books. The association passes `allowNull: true` in `foreignKey`, since MySQL
  rejects `SET NULL` on a `NOT NULL` column.
- `chapters.bookId` is the mirror: `NOT NULL`, `CASCADE`. Check which shape an
  optional link deserves before copying either.
- `comments.parentId` is `SET NULL`, not `CASCADE` (ADR-0002): MySQL fails a
  cascade past 15 levels (`ER_FK_DEPTH_EXCEEDED`, errno 3008), which would take
  a book's delete down with it. `commentRepository.spec.ts` covers a 20-deep
  thread. The replies association declares `onUpdate: 'RESTRICT'`, because a
  self-referential `ON UPDATE CASCADE` silently behaves as `RESTRICT` anyway.
- `comments.userId` is `SET NULL`, the one owner reference that is not
  `CASCADE`: `userRepository.remove` tombstones the account's comments first,
  so an owner-less comment is never live.
- `likes` points at exactly one of `bookId` / `commentId`. Sequelize 6 cannot
  declare the `CHECK`, so the XOR is enforced by a `.refine()` on
  `createLikeSchema` and a model `validate`; no database `CHECK` backs them
  (ADR-0016). Both targets are `ON DELETE CASCADE`, since `SET NULL` would
  produce the state the XOR forbids.
- `likes` has unique indexes on `(userId, bookId)` and `(userId, commentId)`.
  NULLs are distinct in a unique index, so the two do not interfere. They also
  serve `?userId=`; a further index would cost every insert on the busiest
  table.
- `favorites` copies the `likes` shape: exactly one of `bookId` / `seriesId`
  (a `.refine()` on `createFavoriteSchema` and a model `validate`), unique `(userId, bookId)` and `(userId, seriesId)`, and
  `ON DELETE CASCADE` on all three references. A duplicate insert is a `UniqueConstraintError`, which the
  repository maps to 409.
- Creating a book or series maps a `ForeignKeyConstraintError` to
  `NotFoundError('User')`: the first credit is the only reference that can
  fail, because a series is checked under lock by `nextSeriesPosition` first.

## Lock order

Take row locks in this order and never an earlier one after a later one, or two
transactions deadlock:

1. a series row;
2. that series' book rows;
3. a work row (book or series) before its credit rows;
4. a user row before its tokens;
5. comment rows before their reports.

Followed today by `reorderInSeries` and `bookRepository.update` (series, then
book; `update` peeks the series unlocked first and answers a 409 if the book
moved meanwhile), `seriesRepository.remove` (series row, then its book rows),
`userRepository.remove` (credited series, then books, then comments before
reports; see the comment in `remove`), `addCoAuthor` / `removeCoAuthor` (work
row, then credits), and `passwordResetRepository.replaceForUser` / `redeem`
(user, then tokens; see the comments in those two functions).

## Changing a table's shape

There are no migrations (ADR-0016). Boot and the seed run `sequelize.sync()`,
which creates a missing table and never alters an existing one. A schema change
is a model change plus `/db-reset`.

`permissions.module` is an `ENUM` built from `MODULES`, so adding a module
needs the same reset.
