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
  | { type: 'chapterDeleted'; bookId: number; id: number };

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
    // Every book write invalidates the whole `books` prefix: a change to one
    // book can move it into or out of any list (a status change hides it from
    // the main page), and the detail key sits under the same prefix. The
    // `series` prefix goes too, because filing a book into a series, or taking
    // it out, changes that series' book list. The `genres` prefix goes as well:
    // a status change can move a Genre into or out of the list of Genres with a
    // published book.
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
    default:
      change satisfies never;
      return;
  }
};
