import { request } from './client';
import type { UpdateUserPayload } from 'shared';
import type { PublicUser } from '../types/api';

// The Account's own writes: its fields and its Avatar. Its own module, the way
// authors.ts is.
export const updateUser = (
  userId: number,
  changes: UpdateUserPayload
): Promise<PublicUser> => {
  return request<PublicUser>(`/users/${userId}`, {
    method: 'PATCH',
    body: changes,
  });
};

// A fixed body rather than a widened UpdateUserPayload: only a Moderator may send
// `status`, and the Account form must never offer it.
export const blockUser = (userId: number): Promise<PublicUser> => {
  return request<PublicUser>(`/users/${userId}`, {
    method: 'PATCH',
    body: { status: 'blocked' },
  });
};

export const uploadAvatar = (
  userId: number,
  file: File
): Promise<PublicUser> => {
  return request<PublicUser>(`/users/${userId}/avatar`, {
    method: 'PUT',
    body: file,
  });
};

export const deleteAvatar = (userId: number): Promise<void> => {
  return request<void>(`/users/${userId}/avatar`, { method: 'DELETE' });
};
