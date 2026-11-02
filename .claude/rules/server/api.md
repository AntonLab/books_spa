---
paths:
  - 'server/src/routes/**'
  - 'server/src/controllers/**'
  - 'server/src/types/**'
  - 'shared/src/**'
---

# Server API: what the routes promise

The domain terms (Book status, Publication time, Reading order, Series order,
Co-author, Genre) are defined in `CONTEXT.md`. This file holds the rules the
code alone does not explain.

## Books and series

- Neither has an owner column: Co-authors are rows in `book_authors` /
  `series_authors`, all with equal rights (ADR-0005). A series and its books
  keep independent Co-author lists. `?userId=` matches a book through any
  Co-author.
- A page of books loads its `authors` in one extra query (`loadAuthors`), not an
  `include`: an include would make `LIMIT` page over credit rows.
- `AuthorSummary` is `PublicUser` minus the email, which is what makes it safe
  in a public response. `/api/users` reads sit behind the matrix because
  `PublicUser` carries the email; `GET /api/authors?q=` is a separate route for
  the Co-author picker for the same reason.
- `POST /api/books` takes no status: every book starts `draft`. Only `draft`
  changes what anyone may do (see `visibility.md`).
- The search filters combine by AND: `q` (title or description), `status`
  (`in_progress` | `complete`; `draft` is a 400), `releasedFrom`/`releasedTo`
  and `updatedFrom`/`updatedTo` (ISO instants, both bounds inclusive, compared
  with the same `publicationEdge` subqueries the `new` / `updated` sorts use,
  so a book with no Published chapter drops out once any bound is set),
  `author` (login, first or last name of any Co-author, `login` compared
  `COLLATE utf8mb4_0900_ai_ci`) and `seriesTitle`. Text is trimmed, 1–200. A
  start after its end is a 400 pinned to the "from" key. `author` and
  `seriesTitle` are looked up as id lists first, like `userId`.
- `GET /api/books` pages by `current` / `pageSize` (1–`PAGE_SIZE_MAX`,
  default 20), not `limit` / `offset`, and answers `PagedResponse`
  (`{ items, total, current, pageSize }`). The page query returns the total,
  with a separate count only for a page past the end. Past the end it serves
  the last non-empty page, page 1 when nothing matches, and says so in
  `current`. Every other paged list, except the library and reading-list
  lists below, keeps `limit` / `offset` and `ListResponse`; a short list served
  whole (Genres, authors, a series' books) answers `ItemsResponse`, checked
  with `satisfies` at `res.json`.
- The library and reading-list lists take `current` / `pageSize` instead of
  `limit` / `offset`. The repository answers `{ items, total }`; the controller
  echoes `current` / `pageSize`. A page past the end is an empty list, not
  clamped to the last page.
- `?sort=popular|new|updated` ranks by Popularity, Release time or Last update
  (CONTEXT.md), best first, ties to the higher id, overriding Series order.
  Each is a correlated subquery on the book row; `new` and `updated` drop a
  book with no Published chapter. "Published" compares with the process clock,
  as `readableChapterScope` does, so a Scheduled chapter counts once its time
  passes.
- `BookDetail.commentCount` counts live Comments, roots and replies, never a
  Tombstone. `BookDetail.wordCount` sums `chapters.wordCount` over Published
  chapters on the process clock, and the viewer never widens that: a
  Co-author's or Moderator's Draft and Scheduled chapters do not count. Both
  are follow-up queries in `findDetailById`, beside `Like.count`; list rows
  carry neither, and no chapter response carries its own count.
  `BookDetail.favoriteCount` counts every holder, and is 0 while the book is a
  Draft whoever reads it; `viewerFavoriteId` names the viewer's own row even
  then.
- `GET /api/series/:id` answers `SeriesDetail`: `PublicSeries` plus
  `favoriteCount` (every holder; a Series has no status) and
  `viewerFavoriteId`, from `seriesRepository.findDetailById`. `findById`
  stays the plain record for everything else.

## Chapters

- `publishedAt`: `null` is Draft, a future moment Scheduled, a past one
  Published. Nothing flips a flag when the moment passes; every read compares
  with the process clock. A save sends `'now'` (server stamps its own clock),
  a future ISO instant (a past one is 400) or `null`. A Published chapter may
  only return to Draft; its text is edited by leaving `publishedAt` out.
- Every `PATCH /api/chapters/:id` carries `expectedUpdatedAt`;
  `chapterRepository.update` compares it under a row lock and answers 409
  without writing. `chapters.updatedAt` is `DATETIME(3)` so two saves in one
  second read as two versions.

## Reading order and Series order

- `chapters.position` and `books.seriesPosition` are never sent to a client.
  Positions are 1-based and gapped after a delete; only their order matters.
- A new chapter, or a book filed into a series, is appended under a lock on the
  parent row, so two at once cannot share a place. Saving a book into the
  series it is already in keeps its place; leaving the series clears it.
- `PUT /api/books/:id/chapter-order` (`{ chapterIds }`) and
  `PUT /api/series/:id/book-order` (`{ bookIds }`) take every child once, first
  first, and answer 204, or 409 changing nothing when the ids are not exactly
  the current children. The chapter reorder is `silent`, so no `updatedAt`
  moves and an open editor is not handed a spurious 409.
- `GET /api/series/:id/books` names every book in the series, drafts
  included, as a `SeriesBookSummary`; see `visibility.md` for why that is safe.

## Illustrations

- `GET /api/chapters/:id/illustrations` returns `{ items }` by position, no
  bytes. `POST` answers 201. `PATCH /api/illustrations/:id` edits the caption.
  `DELETE` answers 204.
- `PUT /api/chapters/:id/illustration-order` (`{ illustrationIds }`) answers 200
  `{ items }`, or 409 changing nothing when the ids are not exactly the current
  set. It is `silent`, like the chapter reorder.
- A caption is trimmed, blank becomes `null`, max 200. Position is never sent.
- None of these writes moves `chapters.updatedAt`, so an open Chapter editor is
  not handed a 409, and no Notification is sent.

## Comments and Notifications

- `GET /api/comments` returns a flat page (`parentId`, embedded `author`,
  `likeCount`, `viewerLikeId`); the client assembles the tree, which keeps
  paging meaningful. Deletion is soft (see `visibility.md`).
- `/api/notifications` sits behind `requireAuth`, not the matrix; whose
  notifications they are comes from the session only. A read Notification is
  hidden after `NOTIFICATION_READ_TTL_MS` (`operations.md`). `GET`/`PATCH /api/notifications/settings` carry the
  Account's email switch (`users.emailNotifications`, default on); it is kept
  out of `PublicUser` because Admins read other Accounts' `PublicUser`.

## Genres (ADR-0008)

- A Book and a Series each carry at most one Genre; nothing is inherited
  between a series and its books.
- `genres.name` is unique regardless of case: the model pins
  `utf8mb4_0900_ai_ci` on the table rather than trusting the server default.
  The in-memory fake lower-cases names, because the collation is not there. A
  rename to another casing of the same name is allowed.
- `books.genreId` / `series.genreId` are `ON DELETE SET NULL`; deleting a Genre
  raises no Notification.
- An unknown `?genreId=` yields an empty list, like an unknown `?tag=`. An
  unknown `genreId` in a body is a 400 with no `details` key, unlike a zod
  failure, which always has one.
- Absent `genreId` on a create means `null`; absent on a `PATCH` leaves it
  alone.
- `GET /api/genres?nonEmpty=true` lists only Genres holding an `in_progress`
  or `complete` Book (a fixed subquery), so a Draft book never reveals its
  Genre. The header menu and the search form use it; the forms and
  GenreManager take the whole list.

## Zod traps

- **`.partial()` does not undo `.default()`.** A PATCH schema derived from a
  create schema that defaults `tags` to `[]` or `seriesId` to `null` would wipe
  the tags, or unlink the book from its series, on every body that omits the
  key. `update*` schemas are spelled out instead (`types/series.ts`,
  `types/book.ts`). An explicit `seriesId: null` is how a book leaves a series.
- **`z.coerce.boolean()` turns `"false"` into `true`.** Boolean query filters
  use `z.stringbool()` (`listLikesQuerySchema`). A JSON body needs no such care.
