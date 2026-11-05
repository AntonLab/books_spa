import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createComment,
  deleteComment,
  listComments,
  restoreComment,
  updateComment,
} from '../api/comments';
import type { CreateCommentPayload } from 'shared';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

export const useComments = (bookId: number) => {
  return useInfiniteQuery({
    queryKey: queryKeys.comments(bookId),
    queryFn: ({ pageParam }) => listComments(bookId, pageParam),
    initialPageParam: 0,
    // An empty page ends paging, or a total the server overstates would loop.
    getNextPageParam: (last) => {
      const next = last.offset + last.items.length;
      return last.items.length > 0 && next < last.total ? next : undefined;
    },
  });
};

// All four mutations settle through `commentChanged`.
const useCommentMutation = <TVariables>(
  bookId: number,
  mutationFn: (variables: TVariables) => Promise<unknown>
) => {
  const queryClient = useQueryClient();

  return useMutation({
    // Wrapped rather than passed straight through: TanStack calls a mutationFn
    // with a second context argument, and forwarding that into an API function
    // would hand it a stray parameter it never asked for.
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () =>
      applyChange(queryClient, { type: 'commentChanged', bookId }),
  });
};

export const useCreateComment = (bookId: number) => {
  return useCommentMutation<CreateCommentPayload>(bookId, createComment);
};

export const useUpdateComment = (bookId: number) => {
  return useCommentMutation<{ id: number; text: string }>(
    bookId,
    ({ id, text }) => updateComment(id, text)
  );
};

export const useDeleteComment = (bookId: number) => {
  return useCommentMutation<number>(bookId, deleteComment);
};

export const useRestoreComment = (bookId: number) => {
  return useCommentMutation<number>(bookId, restoreComment);
};
