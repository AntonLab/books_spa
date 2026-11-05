import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { createLike, deleteLike } from '../api/likes';
import { applyChange } from './applyChange';
import type { CreateLikePayload } from 'shared';

// One hook for both directions, because the button has one job. `existingId` is
// what the caller already holds from viewerLikeId: null means "like", a number
// means "unlike that row". `invalidates` is passed in rather than derived — a
// book like refreshes the book, a comment like refreshes the thread.
export const useToggleLike = (invalidates: QueryKey) => {
  const queryClient = useQueryClient();

  return useMutation({
    // Returns nothing on either branch. The created row is discarded on
    // purpose: the invalidation below refetches the count and the viewer's own
    // like id from the server, so nothing here needs the response.
    mutationFn: async (variables: {
      existingId: number | null;
      payload: CreateLikePayload;
    }): Promise<void> => {
      if (variables.existingId === null) {
        await createLike(variables.payload);
        return;
      }
      await deleteLike(variables.existingId);
    },
    // onSettled, not onSuccess: a 409 (liked from another tab) or a 404
    // (already unliked) means the count and the viewer's like id on screen
    // are stale, and only the refetch puts them right.
    onSettled: () =>
      applyChange(queryClient, { type: 'likeToggled', detailKey: invalidates }),
  });
};
