import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createBook,
  deleteBook,
  deleteBookCover,
  getBook,
  listBooks,
  listFavoritedBooks,
  updateBook,
  uploadBookCover,
  type ListBooksParams,
} from '../api/books';
import type { BookSort, CreateBookPayload, UpdateBookPayload } from 'shared';
import { BOOK_IDS_MAX, PAGE_SIZE_MAX } from 'shared';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

const BOOKS_PAGE_SIZE = 20;

// A ranking's first `pageSize` books, for the main page's sections; the search
// page pages through `useBookSearch` instead.
export const useSortedBooks = (sort: BookSort, pageSize = BOOKS_PAGE_SIZE) => {
  const params: ListBooksParams = {
    sort,
    pageSize,
    hideNotInterested: 'true',
  };
  return useQuery({
    queryKey: queryKeys.books(params),
    queryFn: () => listBooks(params),
  });
};

const RECENTLY_VIEWED_SIZE = 6;

// The Books of a viewing history, newest first. The request and key use the ids
// as a set, so a re-opened Book (order change only) reuses the cached answer.
export const useRecentlyViewedBooks = (ids: number[]) => {
  const asked = [...ids].sort((a, b) => a - b).join(',');
  return useQuery({
    queryKey: queryKeys.books({ ids: asked, pageSize: BOOK_IDS_MAX }),
    queryFn: () => listBooks({ ids: asked, pageSize: BOOK_IDS_MAX }),
    enabled: ids.length > 0,
    // The slice comes after the server dropped some: BOOK_IDS_MAX ids are
    // asked so that RECENTLY_VIEWED_SIZE can still show.
    select: (page) =>
      page.items
        .filter((item) => ids.includes(item.id))
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        .slice(0, RECENTLY_VIEWED_SIZE),
  });
};

// The search page's one query: every filter, the page and its size, straight
// from the URL. `enabled` is false while the URL's Genre is unresolved or
// gone, so no book is asked for then; a disabled query reports isPending
// forever, which is why useSearchPage hands the page no books in that state.
export const useBookSearch = (params: ListBooksParams, enabled: boolean) => {
  return useQuery({
    queryKey: queryKeys.books(params),
    queryFn: () => listBooks(params),
    enabled,
  });
};

// The key carries `favoritedBy` so a favorited list never shares a cache entry
// with the same search over all works.
export const useFavoritedBooks = (
  params: ListBooksParams,
  enabled: boolean
) => {
  return useQuery({
    queryKey: queryKeys.books({ ...params, favoritedBy: 'me' }),
    queryFn: () => listFavoritedBooks(params),
    enabled,
  });
};

// A series' books, in its Series order: the server sorts a `seriesId` list by
// position rather than by id, and leaves out what the viewer may not read.
// ponytail: one page at the server's cap; page it if a series ever outgrows 100.
export const useBooksInSeries = (seriesId: number) => {
  return useQuery({
    queryKey: queryKeys.books({ seriesId, pageSize: PAGE_SIZE_MAX }),
    queryFn: () => listBooks({ seriesId, pageSize: PAGE_SIZE_MAX }),
  });
};

// The viewer's own books in no series: what the Edit series Books tab can file.
// The server filters by author and searches `q` (title or description), so a
// book past the first 100 is reachable by title; `select` drops books already
// in a series.
// ponytail: a search shows at most one page (the server's cap) of matches.
export const useOwnBooksWithoutSeries = (
  userId: number,
  q: string,
  enabled: boolean
) => {
  const params: ListBooksParams = {
    userId,
    pageSize: PAGE_SIZE_MAX,
    q: q.trim() === '' ? undefined : q.trim(),
  };
  return useQuery({
    queryKey: queryKeys.books(params),
    queryFn: () => listBooks(params),
    // `more` is true when the server holds books past this page, which `select`
    // cannot see: an empty `books` then does not mean nothing is left to add.
    select: (page) => ({
      books: page.items.filter((book) => book.seriesId === null),
      more: page.total > page.items.length,
    }),
    enabled,
  });
};

export const useBook = (id: number) => {
  return useQuery({
    queryKey: queryKeys.book(id),
    queryFn: () => getBook(id),
  });
};

// Only a delete (deletedId) also applies bookDeleteFailed on error; see applyChange.
const useBookMutation = <TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  { deletedId }: { deletedId?: number } = {}
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () =>
      applyChange(
        queryClient,
        deletedId === undefined
          ? { type: 'bookChanged' }
          : { type: 'bookDeleted', id: deletedId }
      ),
    ...(deletedId !== undefined && {
      onError: () => applyChange(queryClient, { type: 'bookDeleteFailed' }),
    }),
  });
};

export const useCreateBook = () =>
  useBookMutation((payload: CreateBookPayload) => createBook(payload));

export const useUpdateBook = (id: number) =>
  useBookMutation((payload: UpdateBookPayload) => updateBook(id, payload));

export const useDeleteBook = (id: number) =>
  useBookMutation(() => deleteBook(id), { deletedId: id });

export const useUploadBookCover = (id: number) =>
  useBookMutation((file: File) => uploadBookCover(id, file));

export const useDeleteBookCover = (id: number) =>
  useBookMutation(() => deleteBookCover(id));
