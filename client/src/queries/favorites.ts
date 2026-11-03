import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { createFavorite, deleteFavorite } from '../api/favorites';
import type { CreateFavoritePayload } from 'shared';
import { applyChange } from './applyChange';

// One hook for both directions, as useToggleLike: `existingId` is the
// viewerFavoriteId the caller holds (null adds, a number removes that row),
// and `invalidates` is the work's own detail key.
export const useToggleFavorite = (invalidates: QueryKey) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: {
      existingId: number | null;
      payload: CreateFavoritePayload;
    }): Promise<void> => {
      if (variables.existingId === null) {
        await createFavorite(variables.payload);
        return;
      }
      await deleteFavorite(variables.existingId);
    },
    // onSettled, not onSuccess: a 409 (added from another tab) or a 404
    // (already removed) means the star and the count on screen are stale,
    // and only the refetch puts them right.
    onSettled: () =>
      applyChange(queryClient, {
        type: 'favoriteToggled',
        detailKey: invalidates,
      }),
  });
};

// The Favorites page's remove. onSettled for the reason useToggleFavorite gives.
export const useRemoveFavorite = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => deleteFavorite(id),
    onSettled: () => applyChange(queryClient, { type: 'favoriteRemoved' }),
  });
};
