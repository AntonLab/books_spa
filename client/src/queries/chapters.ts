import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createChapter,
  deleteChapter,
  getChapter,
  listChapters,
  reorderChapters,
  updateChapter,
} from '../api/chapters';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';
import { useOptimisticReorder } from './reorder';
import type {
  CreateChapterPayload,
  ListResponse,
  UpdateChapterPayload,
} from 'shared';
import type { ChapterSummary } from '../types/chapter';

// ChapterPage reads this same key, so arriving from BookPage costs no request:
// only the chapter body is fetched there.
export const useChapters = (bookId: number) => {
  return useQuery({
    queryKey: queryKeys.chapters(bookId),
    queryFn: () => listChapters(bookId),
  });
};

export const useChapter = (id: number) => {
  return useQuery({
    queryKey: queryKeys.chapter(id),
    queryFn: () => getChapter(id),
  });
};

// What each write refreshes lives in applyChange.
const useChapterMutation = <TVariables, TResult>(
  bookId: number,
  mutationFn: (variables: TVariables) => Promise<TResult>,
  deletedId?: number
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () => {
      void applyChange(
        queryClient,
        deletedId === undefined
          ? { type: 'chapterChanged', bookId }
          : { type: 'chapterDeleted', bookId, id: deletedId }
      );
    },
  });
};

export const useCreateChapter = (bookId: number) =>
  useChapterMutation(bookId, (payload: CreateChapterPayload) =>
    createChapter(payload)
  );

export const useUpdateChapter = (bookId: number, id: number) =>
  useChapterMutation(bookId, (payload: UpdateChapterPayload) =>
    updateChapter(id, payload)
  );

export const useDeleteChapter = (bookId: number, id: number) =>
  useChapterMutation(bookId, () => deleteChapter(id), id);

// Saves the book's Reading order on drop; see useOptimisticReorder.
export const useReorderChapters = (bookId: number) =>
  useOptimisticReorder<ListResponse<ChapterSummary>>(
    queryKeys.chapters(bookId),
    [],
    (chapterIds) => reorderChapters(bookId, chapterIds)
  );
