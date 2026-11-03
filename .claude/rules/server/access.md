---
paths:
  - 'server/src/controllers/**'
  - 'server/src/repositories/**'
  - 'server/src/models/Like.ts'
---

# Who may touch which row

`permissions.md` grades the module; this file is the row-level half. See
`.claude/rules/server/visibility.md` for who may read a row (Draft books,
Notifications, comment tombstones).

## Ownership

- Checked on books, series, chapters, comments and likes in the controllers,
  not in a middleware: the row must be loaded before an owner can be compared.
  The row is looked up under every scope, so a missing one is 404 before
  anything else, a Moderator's Cover upload included (no image is processed);
  a scope of `any` then skips only the owner comparison. Every check answers
  404 before 403.
- Books, series, chapters and illustrations share one rule,
  `createCoAuthorGuard` in `controllers/coAuthorGuard.ts`. It is built from the
  four repositories. Its methods take a ref (`{ book }`, `{ series }`,
  `{ chapter }`, `{ illustration }`) and do the 404, then the 403.
  `assertMayChange` (a Co-author, or `any` once the row exists) is for edits and
  orders, `assertCoAuthor` (a Co-author, whatever the scope) for the byline,
  `assertMayRemoveCredit` for taking a credit off a work. Comments and likes
  (`assertOwner` / `assertOwned`) compare a single owner.
- A book's or series' `own` means one of its Co-authors (`findCoAuthorIds`).
  Chapters have no owner column and resolve through their book; a chapter
  create and reorder check the book, since there is no chapter to own.
- **Filing a book into a series takes a Co-author of both**
  (`assertMayAddToSeries`), or an author could file into a stranger's series. A
  missing series is a 404 blaming the series, ahead of the book's 403. `null`
  or an absent key touches no series and needs no check.
- **Either side may take a book out of a series**: the book's Co-author through
  `PATCH seriesId: null`, the series' Co-author through
  `DELETE /api/series/:id/books/:bookId` (404 if the book is not in that series).
- **The self-like ban** lives in `likeRepository.create`, the one
  check-then-write there. Safe because a comment's owner never changes, and a
  credit landing between check and insert leaves at worst one early like.
  Uniqueness stays with the indexes.
- **Favorites are private.** Every read and the delete are scoped by the
  session's account in `favoriteRepository`, not compared in the controller,
  so another account's Favorite answers the same 404 as a missing one. Adding
  one needs the work to be readable (`readableBookWhere` /
  `visibleSeriesWhere`): a hidden Draft is 404 like a missing id. A book
  returned to Draft keeps its Favorite rows but leaves the list and counts
  zero on `BookDetail.favoriteCount`; its own Co-authors and Moderators still
  see `viewerFavoriteId`.

## Co-authors (ADR-0005)

Every rule holds for books and for series, and each is written once: the
handlers in `controllers/creditHandlers.ts` (both controllers spread them in),
who may act in `controllers/coAuthorGuard.ts`, and the repository rules in
`repositories/coAuthors.ts`, which each repository hands an adapter over its
own credit table.

- **Adding** rides on `× update` and then requires the caller to be credited,
  which a Moderator never is: Moderators edit or delete any work but never
  change its byline. Refused: an account without the `author` Role (400), a
  missing account (404), one already credited (409, from the unique index, not
  a lookup).
- **Removing** sits behind `requireAuth`, not `requirePermission`, so a
  Co-author who switched to `user` (`none` on books) can still leave.
  `assertMayRemoveCredit` holds the rule: anyone may remove themselves (no
  lookup; the repository answers 404/409); removing someone else needs a scope
  of exactly `own` (else 403 before any lookup, so `none` and `any` are both
  refused) and a credit.
- **A work always keeps one Co-author.** An uncredited account is 404 (checked
  first, so a stranger learns nothing), the last one is 409. The count and the
  delete run under `SELECT … FOR UPDATE` on the work row, or two Co-authors
  leaving at once would each count two.
- **Deleting an account deletes only the works it was the last Co-author of**
  (`userRepository.remove`, under the same row locks). A deleted series only
  unlinks its books.
- Switching Role from `author` to `user` keeps every credit; the matrix alone
  removes write access.
