---
paths:
  - 'client/src/queries/**'
---

# `src/queries/`

The TanStack Query layer and the only caller of `src/api/`. Flat files, outside
the Atomic Design levels. Every cache key lives in `keys.ts`.

- **A query retries only what may pass on its own**: at most twice, and only a
  failure that is not an `ApiError` (network) or is a 5xx
  (`shouldRetryQuery`). A 401 from `/auth/me` is the normal answer for a Guest.
  `staleTime` is 30 s. **Mutations never retry**: a write that landed would
  land twice.
- **The session is `PublicUser | null`, never `undefined`.** `useSession` maps
  the 401 to `null` inside the `queryFn`; TanStack rejects an `undefined`
  return, which keeps "asked, nobody" apart from "not asked".
- **The session follows every tab** (`watchSession`, wired to the app's client
  only): a `setQueryData` on the session is announced on the `books.session`
  BroadcastChannel and the other tabs refetch `/auth/me`; a changed Account id
  invalidates every other query (`accountSwitched`), except the notifications and the notification
  settings, which it removes: the bell and the settings switch can still be
  mounted then, and a refetch would ask as the next Account (a 401 on Sign out).
  So only a mutation's own answer may `setQueryData` the session, never a guess.
  `useSession` also refetches on every focus (`'always'`), and a 401 on any
  query or mutation while an Account is shown refetches it too (a Lost session,
  `sessionStale`):
  never a `setQueryData(null)`, since a sign-in elsewhere may have overtaken the
  request.
- **A disabled query reports `isPending: true` forever** (with
  `fetchStatus: 'idle'`). `useBookSearch` is disabled while the URL's Genre is
  unresolved or gone, which is why `useSearchPage` reports a status with no
  `books` then.
- `useGenresWithBooks` (`?nonEmpty=true`, under the `genres` prefix) feeds the
  header menu and the search form; book forms and `GenreManager` keep
  `useGenres`.
- **Wrap every `mutationFn`; never pass an `src/api/` function straight
  through.** TanStack passes a second context argument, which arrives as a
  stray parameter and fails `toHaveBeenCalledWith` naming
  `{ client, meta, mutationKey }`.
- **Invalidate every prefix a write can change, through `applyChange`
  (`applyChange.ts`).** Add a `Change` intent there, never an
  `invalidateQueries` call in a hook. A Comment write and a chapter create,
  save or delete also invalidate `queryKeys.book(bookId)`: the detail carries
  `commentCount` and `wordCount` for `BookPage`'s Statistics tab. A chapter
  reorder does not.
- `useToggleLike` handles both directions from the `viewerLikeId` the caller
  holds (`null` likes, a number deletes that row) and takes the key to
  invalidate, since a book like and a comment like refresh different things.
- `useToggleFavorite` mirrors it for Favorites but invalidates in
  `onSettled`, not `onSuccess`: a 409 or 404 means another tab already
  changed the Favorite, and the refetch is what corrects the star. Both it
  and `useRemoveFavorite` invalidate the `favorites` prefix.
- `useOptimisticReorder` (`reorder.ts`) is the one save-on-drop for both
  orders: it rewrites the cache before the request, restores it on failure
  and refetches either way, so a 409 brings in the row a Co-author changed.
- `useNotifications` is the only polling query: every 60 s and on window focus.
  `useNotificationStream` adds the live path: each pushed Notification
  invalidates it (`notificationsChanged`). A stream the browser gives up on
  (CLOSED, most often a 401) invalidates the session instead
  (`sessionStale`), so an ended session becomes a Lost
  session, and one retry follows 30 s later; the browser's own reconnects
  (CONNECTING) are left alone. The opener lives in `api/notificationStream.ts`,
  apart from `api/notifications.ts`, because tests automock the latter.
- `useNotificationSettings` is keyed without the Account id on purpose: its
  answer is always the session's, so `watchSession` removes it on an Account
  change. `useUpdateNotificationSettings` writes the PATCH
  answer into the cache.
- `@tanstack/react-query-devtools` is pinned to the same version as
  `@tanstack/react-query`: bump both together, since the devtools read the
  core's internals.
- `useSeriesBooks` stays disabled until the page knows the viewer may edit the
  series.
