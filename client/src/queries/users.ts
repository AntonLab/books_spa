import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteAvatar, updateUser, uploadAvatar } from '../api/users';
import type { UpdateUserPayload } from 'shared';
import { applyChange } from './applyChange';

// An Account change touches every place an AuthorSummary or a PublicUser is
// embedded: the session itself, and every books/series/comments list
// or detail that names its owner, plus the author-picker's search cache.
// These endpoints answer a bare PublicUser, so the hook never writes it into
// the session (that would drop `permissions`): it invalidates, and /auth/me
// answers the whole SessionUser again.
const useAccountMutation = <TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>
) => {
  const queryClient = useQueryClient();

  return useMutation({
    // Wrapped rather than passed straight through, as every mutationFn here
    // is: TanStack calls it with a second context argument an api/ function
    // never declared.
    mutationFn: (variables: TVariables) => mutationFn(variables),
    onSuccess: () => applyChange(queryClient, { type: 'accountChanged' }),
  });
};

export const useUpdateAccount = (userId: number) =>
  useAccountMutation((changes: UpdateUserPayload) =>
    updateUser(userId, changes)
  );

export const useUploadAvatar = (userId: number) =>
  useAccountMutation((file: File) => uploadAvatar(userId, file));

export const useDeleteAvatar = (userId: number) =>
  useAccountMutation(() => deleteAvatar(userId));
