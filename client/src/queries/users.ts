import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteAvatar, updateUser, uploadAvatar } from '../api/users';
import type { UpdateUserPayload } from 'shared';
import { applyChange } from './applyChange';

// These endpoints answer a bare PublicUser; applyChange decides what goes stale and never writes the session (see applyChange.ts).
const useAccountMutation = <TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>
) => {
  const queryClient = useQueryClient();

  return useMutation({
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
