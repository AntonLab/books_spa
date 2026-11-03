import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createGenre,
  deleteGenre,
  listGenreCounts,
  listGenres,
  updateGenre,
} from '../api/genres';
import type { GenrePayload, GenreUpdatePayload } from 'shared';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

// The whole flat list, unpaged: both forms' select reads this entry.
export const useGenres = () => {
  return useQuery({
    queryKey: queryKeys.genres,
    queryFn: () => listGenres(),
  });
};

// Only the Genres a reader can find a book in: the header's menu and the
// search form's select. Book forms keep useGenres.
export const useGenresWithBooks = () => {
  return useQuery({
    queryKey: queryKeys.genresWithBooks,
    queryFn: () => listGenres({ nonEmpty: true }),
  });
};

// The management page's list: every Genre with its Book and Series counts.
export const useGenresCounts = () => {
  return useQuery({
    queryKey: queryKeys.genresCounts,
    queryFn: () => listGenreCounts(),
  });
};

// Key list: applyChange.
const useGenreMutation = <TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () => applyChange(queryClient, { type: 'genreChanged' }),
  });
};

export const useCreateGenre = () =>
  useGenreMutation((payload: GenrePayload) => createGenre(payload));

export const useUpdateGenre = () =>
  useGenreMutation(
    ({ id, payload }: { id: number; payload: GenreUpdatePayload }) =>
      updateGenre(id, payload)
  );

export const useDeleteGenre = () =>
  useGenreMutation((id: number) => deleteGenre(id));
