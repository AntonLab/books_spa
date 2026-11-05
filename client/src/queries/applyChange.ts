import {
  hashKey,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { queryKeys } from './keys';

export type Change =
  | { type: 'bookChanged' | 'bookDeleteFailed' }
  | { type: 'bookDeleted'; id: number }
  | { type: 'seriesChanged' | 'seriesDeleteFailed' }
  | { type: 'seriesDeleted'; id: number }
  | { type: 'readingListChanged' | 'readingListDeleteFailed' }
  | { type: 'readingListDeleted'; id: number }
  | { type: 'chapterChanged'; bookId: number }
  | { type: 'chapterDeleted'; bookId: number; id: number }
  | { type: 'bookLibraryChanged' }
  | { type: 'seriesLibraryChanged'; id: number }
  | { type: 'readingProgressRecorded' }
  | { type: 'favoriteToggled'; detailKey: QueryKey }
  | { type: 'favoriteRemoved' }
  | { type: 'accountChanged' }
  | { type: 'genreChanged' }
  | { type: 'sessionStale' }
  | { type: 'accountSwitched' }
  | { type: 'notificationsChanged'; userId: number }
  | { type: 'commentChanged'; bookId: number }
  | { type: 'reportSettled'; bookId: number; refreshBook: boolean }
  | { type: 'reportsChanged' }
  | { type: 'illustrationsChanged'; chapterId: number }
  | { type: 'likeToggled'; detailKey: QueryKey }
  | { type: 'listReordered'; keys: QueryKey[] };

// A delete skips the deleted record's own detail: its page is still mounted,
// would refetch into a 404 and redirect with "no longer exists" before the
// delete's own landing page takes over.
const skipDetail = (detailKey: QueryKey) => ({
  predicate: (query: { queryKey: QueryKey }) =>
    hashKey(query.queryKey) !== hashKey(detailKey),
});

// The one place that decides which queries a write leaves stale. It resolves
// after the refetches, so a caller can return it from a mutation callback.
// A `...DeleteFailed` change is for a delete that failed because the record is
// already gone (404) or no longer editable (403): the lists are stale, and the
// detail is refreshed too. A failed update is not a change: it must not refetch
// the form's own data under the user's edits.
export const applyChange = async (
  queryClient: QueryClient,
  change: Change
): Promise<void> => {
  switch (change.type) {
    // A book write can move a book into or out of any list (a status change
    // hides it from the main page), so the whole books prefix goes, detail
    // included. series goes because filing a book changes that series' list.
    // genres goes because a status change can move a Genre in or out of the
    // list with a published book.
    case 'bookChanged':
    case 'bookDeleteFailed':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
        queryClient.invalidateQueries({ queryKey: queryKeys.genres }),
      ]);
      return;
    case 'bookDeleted':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.allBooks,
          ...skipDetail(queryKeys.book(change.id)),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
        queryClient.invalidateQueries({ queryKey: queryKeys.genres }),
      ]);
      return;
    // Every series write invalidates the `series` prefix and the `books` one: a
    // deleted series unlinks its books, and a book taken out of one changes
    // what that book's page shows.
    case 'seriesChanged':
    case 'seriesDeleteFailed':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
      ]);
      return;
    case 'seriesDeleted':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.allSeries,
          ...skipDetail(queryKeys.seriesDetail(change.id)),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
      ]);
      return;
    // Every reading list write refreshes the lists' prefix (page, Profile tab)
    // and the caller's own lists (the Add to reading list state).
    case 'readingListChanged':
    case 'readingListDeleteFailed':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allReadingLists }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.allMyReadingLists,
        }),
      ]);
      return;
    case 'readingListDeleted':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.allReadingLists,
          ...skipDetail(queryKeys.readingList(change.id)),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.allMyReadingLists,
        }),
      ]);
      return;
    // Every chapter write invalidates all chapter queries (the book's list and
    // every detail) and the book's detail. A save can change what a list shows
    // (a draft published) and the record itself. The detail's wordCount sums
    // the Published chapters' text. A delete skips the deleted chapter's own
    // detail: its page or modal is still mounted and would refetch into a 404.
    // (removeQueries would not help: a mounted observer rebuilds the removed
    // query and fetches it again.)
    case 'chapterChanged':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allChapters }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.book(change.bookId),
        }),
      ]);
      return;
    case 'chapterDeleted':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.allChapters,
          ...skipDetail(queryKeys.chapter(change.id)),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.book(change.bookId),
        }),
      ]);
      return;
    // The Library buttons of a Book page. The detail refetch carries the
    // status, so the `books` prefix and the Library both go stale.
    case 'bookLibraryChanged':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allLibrary }),
      ]);
      return;
    // The Series detail carries viewerLibrary, so it is refetched with the
    // Books and the Library.
    case 'seriesLibraryChanged':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.seriesDetail(change.id),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allLibrary }),
      ]);
      return;
    // A reading event can lift not_interested to Reading and finished advances
    // it, so refetch the Books, the Series (viewerLibrary derives from Book
    // statuses) and the Library.
    case 'readingProgressRecorded':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allLibrary }),
      ]);
      return;
    // A toggle refreshes the work's own detail (the star and the count) and
    // the Favorites lists. `detailKey` is passed as given.
    case 'favoriteToggled':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: change.detailKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allFavorites }),
      ]);
      return;
    // Every book and series detail carries the Favorite count and the viewer's
    // Favorite id, so both prefixes go stale with the lists.
    case 'favoriteRemoved':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allFavorites }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
      ]);
      return;
    // An Account change touches every place an AuthorSummary or a PublicUser is
    // embedded: the session itself, every books, series and comments list or
    // detail that names its owner, and the author-picker's search cache. The
    // endpoints answer a bare PublicUser, so the session is invalidated, never
    // written: /auth/me answers the whole SessionUser again.
    case 'accountChanged':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.session }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allComments }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allAuthors }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allAccounts }),
      ]);
      return;
    // `genres` is obvious; `books` and `series` go because a rename or a
    // deletion changes the `genre` embedded in every book and series a cached
    // list already holds.
    case 'genreChanged':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.genres }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allBooks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allSeries }),
      ]);
      return;
    // Another tab or a closed stream says the session may have ended: only
    // /auth/me is asked again, so a Lost session surfaces.
    case 'sessionStale':
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.session }),
      ]);
      return;
    // The session is the query that told us, so refetching it again is
    // pointless; notifications and settings were already removed by the caller.
    case 'accountSwitched':
      await Promise.all([
        queryClient.invalidateQueries({
          predicate: (query) => query.queryHash !== hashKey(queryKeys.session),
        }),
      ]);
      return;
    // A pushed or polled Notification changes only that Account's list.
    case 'notificationsChanged':
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.notifications(change.userId),
        }),
      ]);
      return;
    // Not everything is awaited here: only the thread's refetch is. The modal or
    // form waits on it (CommentSection clears its form when the write settles),
    // and the book's detail, whose commentCount BookPage's Statistics tab shows,
    // refetches behind it. An edit moves no count, but one extra detail refetch
    // is cheaper than a second intent. An Owner's edit or delete settles or
    // reopens Reports; Create fires it too, the extra refetch only runs while a
    // Reports tab is mounted. A comment change cannot affect the chapters or
    // another book's thread.
    case 'commentChanged':
      void queryClient.invalidateQueries({
        queryKey: queryKeys.book(change.bookId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allReports });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.comments(change.bookId),
      });
      return;
    // Settled, not succeeded: a 409 means another Moderator got there first, and
    // the rows must show who. Same wait as commentChanged: only the thread. The
    // book is refreshed only when the Comment became a Tombstone.
    case 'reportSettled':
      void queryClient.invalidateQueries({ queryKey: queryKeys.allReports });
      if (change.refreshBook) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.book(change.bookId),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.comments(change.bookId),
      });
      return;
    // The row's reportedAccount.status changes.
    case 'reportsChanged':
      await queryClient.invalidateQueries({ queryKey: queryKeys.allReports });
      return;
    // No Illustration write moves `chapters.updatedAt`, so never a chapter or
    // book key.
    case 'illustrationsChanged':
      await queryClient.invalidateQueries({
        queryKey: queryKeys.illustrations(change.chapterId),
      });
      return;
    // Runs in onSettled: a 409 or 404 means another tab changed the like, and
    // the refetch corrects what is on screen.
    case 'likeToggled':
      await queryClient.invalidateQueries({ queryKey: change.detailKey });
      return;
    // Callers pass the list key plus what else the order shows; a chapter
    // reorder passes no `book(bookId)`.
    case 'listReordered':
      await Promise.all(
        change.keys.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      );
      return;
    default:
      change satisfies never;
      return;
  }
};
