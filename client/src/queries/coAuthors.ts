import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addCoAuthor, removeCoAuthor } from '../api/books';
import { addSeriesCoAuthor, removeSeriesCoAuthor } from '../api/series';
import { applyChange } from './applyChange';

// A work whose Co-authors are managed: a book or a series. Both keep their
// credits the same way (ADR-0005), through parallel endpoints.
export interface CreditedWork {
  kind: 'book' | 'series';
  id: number;
}

// A credit changes the work's byline, so every list and detail that embeds
// `authors` goes stale. `bookChanged` and `seriesChanged` also refresh genres
// and the opposite books/series prefix; that extra refetch is accepted.
const useCreditMutation = (
  work: CreditedWork,
  forBook: (bookId: number, userId: number) => Promise<unknown>,
  forSeries: (seriesId: number, userId: number) => Promise<unknown>
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: number) =>
      work.kind === 'book'
        ? forBook(work.id, userId)
        : forSeries(work.id, userId),
    onSuccess: () =>
      applyChange(queryClient, {
        type: work.kind === 'book' ? 'bookChanged' : 'seriesChanged',
      }),
  });
};

export const useAddCoAuthor = (work: CreditedWork) =>
  useCreditMutation(work, addCoAuthor, addSeriesCoAuthor);

// Removing someone else and leaving are one mutation, as they are one call.
export const useRemoveCoAuthor = (work: CreditedWork) =>
  useCreditMutation(work, removeCoAuthor, removeSeriesCoAuthor);
