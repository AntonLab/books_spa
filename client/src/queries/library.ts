import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReadingProgressPayload } from 'shared';
import {
  addBookToLibrary,
  addSeriesToLibrary,
  clearReadingStatus,
  listLibrary,
  postReadingProgress,
  removeSeriesFromLibrary,
  toggleBookNotInterested,
  toggleSeriesNotInterested,
  type ListLibraryParams,
} from '../api/library';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

export const useLibrary = (params: ListLibraryParams, enabled = true) => {
  return useQuery({
    queryKey: queryKeys.library(params),
    queryFn: () => listLibrary(params),
    enabled,
  });
};

type LibraryActionFns<V> = {
  addFn: (variables: V) => Promise<unknown>;
  toggleFn: (variables: V) => Promise<unknown>;
  removeFn: (variables: V) => Promise<unknown>;
  onSettled: () => Promise<unknown>;
};

// The three Library buttons of a Book or Series page. Responses are ignored:
// the detail refetch carries the status. onSettled, as in useToggleFavorite: a
// 404 means the work is gone and only the refetch fixes the screen. isPending
// covers all three, so one request is in flight.
const useLibraryActions = <V>({
  addFn,
  toggleFn,
  removeFn,
  onSettled,
}: LibraryActionFns<V>) => {
  const add = useMutation({
    mutationFn: (variables: V) => addFn(variables),
    onSettled,
  });
  const toggleNotInterested = useMutation({
    mutationFn: (variables: V) => toggleFn(variables),
    onSettled,
  });
  const remove = useMutation({
    mutationFn: (variables: V) => removeFn(variables),
    onSettled,
  });

  return {
    add,
    toggleNotInterested,
    remove,
    isPending:
      add.isPending || toggleNotInterested.isPending || remove.isPending,
  };
};

export const useBookLibraryActions = () => {
  const queryClient = useQueryClient();

  return useLibraryActions<number>({
    addFn: addBookToLibrary,
    toggleFn: toggleBookNotInterested,
    removeFn: clearReadingStatus,
    onSettled: () => applyChange(queryClient, { type: 'bookLibraryChanged' }),
  });
};

export const useSeriesLibraryActions = (seriesId: number) => {
  const queryClient = useQueryClient();

  return useLibraryActions<void>({
    addFn: () => addSeriesToLibrary(seriesId),
    toggleFn: () => toggleSeriesNotInterested(seriesId),
    removeFn: () => removeSeriesFromLibrary(seriesId),
    onSettled: () =>
      applyChange(queryClient, { type: 'seriesLibraryChanged', id: seriesId }),
  });
};

// The Chapter page's reading events. Failures stay silent: reading must not be interrupted, and the next event reports again. The answer is a 204, so the server is refetched; see applyChange.
export const useReadingProgressMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: {
      bookId: number;
      payload: ReadingProgressPayload;
    }) => postReadingProgress(variables.bookId, variables.payload),
    onSuccess: () =>
      applyChange(queryClient, { type: 'readingProgressRecorded' }),
  });
};
