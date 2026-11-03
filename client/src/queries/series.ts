import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSeries,
  deleteSeries,
  deleteSeriesCover,
  getSeries,
  listFavoritedSeries,
  listSeries,
  listSeriesBooks,
  removeBookFromSeries,
  reorderSeriesBooks,
  updateSeries,
  uploadSeriesCover,
  type ListSeriesParams,
} from '../api/series';
import { updateBook } from '../api/books';
import type { SeriesPayload } from 'shared';
import type { SeriesBookSummary } from '../types/api';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';
import { useOptimisticReorder } from './reorder';

// The series a Co-author can file a book under, and the Series tab of My
// books. One page at the server's cap: an author's own series are few.
export const useMySeries = (userId: number | undefined) => {
  return useQuery({
    queryKey: queryKeys.series({ userId, limit: 100 }),
    queryFn: () => listSeries({ userId, limit: 100 }),
    enabled: userId !== undefined,
  });
};

export const useSeriesList = (params: ListSeriesParams, enabled: boolean) => {
  return useQuery({
    queryKey: queryKeys.series(params),
    queryFn: () => listSeries(params),
    enabled,
  });
};

// The key carries `favoritedBy` so a favorited list never shares a cache entry
// with the same search over all works.
export const useFavoritedSeries = (
  params: ListSeriesParams,
  enabled: boolean
) => {
  return useQuery({
    queryKey: queryKeys.series({ ...params, favoritedBy: 'me' }),
    queryFn: () => listFavoritedSeries(params),
    enabled,
  });
};

export const useSeries = (id: number) => {
  return useQuery({
    queryKey: queryKeys.seriesDetail(id),
    queryFn: () => getSeries(id),
  });
};

// Disabled until the page knows the viewer may edit the series: anyone else
// would only be refused.
export const useSeriesBooks = (id: number, enabled: boolean) => {
  return useQuery({
    queryKey: queryKeys.seriesBooks(id),
    queryFn: () => listSeriesBooks(id),
    enabled,
  });
};

// Only a delete (deletedId) also applies seriesDeleteFailed on error; see applyChange.
const useSeriesMutation = <TVariables, TResult>(
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
          ? { type: 'seriesChanged' }
          : { type: 'seriesDeleted', id: deletedId }
      ),
    ...(deletedId !== undefined && {
      onError: () => applyChange(queryClient, { type: 'seriesDeleteFailed' }),
    }),
  });
};

export const useCreateSeries = () =>
  useSeriesMutation((payload: SeriesPayload) => createSeries(payload));

export const useUpdateSeries = (id: number) =>
  useSeriesMutation((payload: Partial<SeriesPayload>) =>
    updateSeries(id, payload)
  );

export const useDeleteSeries = (id: number) =>
  useSeriesMutation(() => deleteSeries(id), { deletedId: id });

export const useUploadSeriesCover = (id: number) =>
  useSeriesMutation((file: File) => uploadSeriesCover(id, file));

export const useDeleteSeriesCover = (id: number) =>
  useSeriesMutation(() => deleteSeriesCover(id));

export const useRemoveBookFromSeries = (seriesId: number) =>
  useSeriesMutation((bookId: number) => removeBookFromSeries(seriesId, bookId));

export const useAddBookToSeries = (seriesId: number) =>
  useSeriesMutation((bookId: number) => updateBook(bookId, { seriesId }));

// Saves the Series order on drop; see useOptimisticReorder. allBooks refreshes
// useBooksInSeries, which feeds the Series page grid.
export const useReorderSeriesBooks = (seriesId: number) =>
  useOptimisticReorder<{ items: SeriesBookSummary[] }>(
    queryKeys.seriesBooks(seriesId),
    [queryKeys.allBooks],
    (bookIds) => reorderSeriesBooks(seriesId, bookIds)
  );
