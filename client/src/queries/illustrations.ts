import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteIllustration,
  listIllustrations,
  reorderIllustrations,
  updateIllustrationCaption,
  uploadIllustration,
} from '../api/illustrations';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';
import { useOptimisticReorder } from './reorder';
import type { ItemsResponse } from 'shared';
import type { PublicIllustration } from '../types/illustration';

export const useIllustrations = (chapterId: number) => {
  return useQuery({
    queryKey: queryKeys.illustrations(chapterId),
    queryFn: () => listIllustrations(chapterId),
  });
};

// No Illustration write moves `chapters.updatedAt`, so only the chapter's own
// list is refreshed, never a chapter or book key.
const useIllustrationMutation = <TVariables, TResult>(
  chapterId: number,
  mutationFn: (variables: TVariables) => Promise<TResult>
) => {
  const queryClient = useQueryClient();

  return useMutation({
    // Wrapped rather than passed straight through: TanStack calls a mutationFn
    // with a second context argument an API function never declared.
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () => {
      void applyChange(queryClient, {
        type: 'illustrationsChanged',
        chapterId,
      });
    },
  });
};

export const useUploadIllustration = (chapterId: number) =>
  useIllustrationMutation(chapterId, (file: File) =>
    uploadIllustration(chapterId, file)
  );

export const useUpdateIllustrationCaption = (chapterId: number) =>
  useIllustrationMutation(
    chapterId,
    ({ id, caption }: { id: number; caption: string | null }) =>
      updateIllustrationCaption(id, caption)
  );

export const useDeleteIllustration = (chapterId: number) =>
  useIllustrationMutation(chapterId, (id: number) => deleteIllustration(id));

// Saves the chapter's order on drop; see useOptimisticReorder.
export const useReorderIllustrations = (chapterId: number) =>
  useOptimisticReorder<ItemsResponse<PublicIllustration>>(
    queryKeys.illustrations(chapterId),
    [],
    (ids) => reorderIllustrations(chapterId, ids).then(() => undefined)
  );
