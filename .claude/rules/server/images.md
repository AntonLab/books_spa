---
paths:
  - 'server/src/images.ts'
  - 'server/src/models/BookCover.ts'
  - 'server/src/models/SeriesCover.ts'
  - 'server/src/models/UserAvatar.ts'
  - 'server/src/routes/bookRoutes.ts'
  - 'server/src/routes/seriesRoutes.ts'
  - 'server/src/routes/userRoutes.ts'
  - 'server/src/models/Illustration.ts'
  - 'server/src/models/IllustrationImage.ts'
  - 'server/src/routes/illustrationRoutes.ts'
  - 'server/src/routes/chapterRoutes.ts'
---

# Covers and Avatars (ADR-0007)

- Stored as bytes in `book_covers` / `series_covers` / `user_avatars`, keyed by the
  Book's, Series' or Account's id, never as a column on `books`/`series`/`users`,
  so no list query can drag them along. Each cascades from that row, so a deleted
  Book, Series or Account takes its picture with it, with no application code.
- Every `sharp` call lives in `src/images.ts`. It decodes the upload for real
  (`metadata().format`, never the `Content-Type` header), applies and drops
  EXIF orientation, centre-crops to 600×900 or 256×256 and re-encodes WebP with
  no metadata. The upload's own bytes are never stored; an animation keeps its
  first frame.
- `PUT`/`DELETE`/`GET /api/books/:id/cover` ride on `books × update` / `read`;
  `PUT`/`DELETE`/`GET /api/series/:id/cover` on `series × update` / `read`; the
  avatar `PUT`/`DELETE` on `users × update`. **`GET /api/users/:id/avatar`
  has no permission middleware**, since a Guest lacks `users × read`. Walking
  ids therefore collects every Avatar, unnamed; accepted, since ids are public
  in every `AuthorSummary`.
- `express.raw()` is mounted on the three `PUT`s only, after `requirePermission`
  and `validate`, so a refused request never has its 2 MiB body read. Then, in
  order: 415 when `Content-Type` was not accepted (`req.body` is no `Buffer`),
  the row's 404/403, and `sharp`'s 400 ("Not a valid image"), which also covers
  bytes over its pixel limit. Over 2 MiB is 413 through `errorHandler`.
- Both `GET`s send `Cache-Control: private, max-age=31536000, immutable`. Safe
  because `coverUrl` / `avatarUrl` carry `?v=<updatedAt ms>`, so a replace is
  never served stale.
- A Cover is a field of the Book or the Series and an Avatar a field of the Account: no matrix
  row of its own, last write wins, no Notification.
- `ACCEPTED_IMAGE_CONTENT_TYPES` and `IMAGE_MAX_BYTES` come from `shared`,
  because the client prechecks against the same limits.

## Illustrations

- Bytes sit in `illustration_images`, apart from `illustrations`, with the same
  cascade: a Chapter delete takes both.
- `processIllustrationImage` fits inside 1600×1600, never enlarges, keeps the
  aspect ratio and re-encodes WebP without metadata.
- Writes ride on `chapters × update` plus the Co-author guard (404, then 403).
  Reads ride on `chapters × read` plus the Chapter's own visibility, so a Draft
  or Scheduled Chapter's picture is refused by direct link too.
- `express.raw()` is mounted on the upload only, after `requirePermission` and
  `validate`, with the same 415/400/413 order as a Cover.
- The image `GET` reuses `sendCover`'s headers. Its URL carries no `?v=`: the
  bytes are never replaced, so the client builds it from the id alone and a
  caption save keeps the cached picture.
- At most 20 per Chapter, enforced under the chapter row lock (409).
