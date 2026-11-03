import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { applyChange } from './applyChange';
import { useChangePassword } from './auth';
import { queryKeys } from './keys';
import { useDeleteAvatar, useUpdateAccount, useUploadAvatar } from './users';
import { createTestQueryClient } from '../test/queryClient';
import { seedSession, sessionOf } from '../test/session';
import * as usersApi from '../api/users';
import type { PublicUser } from '../types/api';

jest.mock('../api/users');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));
const mockedUsers = jest.mocked(usersApi);
const mockedApplyChange = jest.mocked(applyChange);

const session: PublicUser = {
  id: 7,
  login: 'bob',
  email: 'bob@example.com',
  firstName: 'Bob',
  lastName: 'Bobson',
  status: 'active',
  role: 'user',
  avatarUrl: null,
  about: '',
  showLastSeen: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const wrapper = (client = createTestQueryClient()) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'QueryClientWrapper';
  return Wrapper;
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
});

describe('useUploadAvatar', () => {
  it('uploads and reports accountChanged', async () => {
    mockedUsers.uploadAvatar.mockResolvedValue({
      ...session,
      avatarUrl: '/api/users/7/avatar?v=2',
    });
    const client = createTestQueryClient();
    const file = new File([new Uint8Array([1])], 'a.webp', {
      type: 'image/webp',
    });

    const { result } = renderHook(() => useUploadAvatar(7), {
      wrapper: wrapper(client),
    });
    result.current.mutate(file);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedUsers.uploadAvatar).toHaveBeenCalledWith(7, file);
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'accountChanged',
    });
  });

  it('reports nothing when the upload fails', async () => {
    mockedUsers.uploadAvatar.mockRejectedValue(new Error('nope'));
    const file = new File([new Uint8Array([1])], 'a.webp', {
      type: 'image/webp',
    });
    const { result } = renderHook(() => useUploadAvatar(7), {
      wrapper: wrapper(),
    });

    await expect(result.current.mutateAsync(file)).rejects.toThrow('nope');

    expect(mockedApplyChange).not.toHaveBeenCalled();
  });
});

describe('useUpdateAccount', () => {
  it('updates the user and reports accountChanged', async () => {
    mockedUsers.updateUser.mockResolvedValue({ ...session, login: 'x' });
    const client = createTestQueryClient();

    const { result } = renderHook(() => useUpdateAccount(7), {
      wrapper: wrapper(client),
    });
    await expect(result.current.mutateAsync({ login: 'x' })).resolves.toEqual({
      ...session,
      login: 'x',
    });

    expect(mockedUsers.updateUser).toHaveBeenCalledWith(7, { login: 'x' });
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'accountChanged',
    });
  });

  it('reports nothing when the update fails', async () => {
    mockedUsers.updateUser.mockRejectedValue(new Error('nope'));
    const client = createTestQueryClient();

    const { result } = renderHook(() => useUpdateAccount(7), {
      wrapper: wrapper(client),
    });
    await expect(result.current.mutateAsync({ login: 'x' })).rejects.toThrow(
      'nope'
    );

    expect(mockedApplyChange).not.toHaveBeenCalled();
  });
});

describe('the session after an Account change', () => {
  it('keeps the permissions the session already holds', async () => {
    const withPermissions = sessionOf(session, 'any');
    mockedUsers.updateUser.mockResolvedValue({ ...session, about: 'Hi' });
    const client = createTestQueryClient();
    seedSession(client, session, 'any');

    const { result } = renderHook(() => useUpdateAccount(7), {
      wrapper: wrapper(client),
    });
    await result.current.mutateAsync({ about: 'Hi' });

    expect(client.getQueryData(queryKeys.session)).toEqual(withPermissions);
  });
});

describe('useChangePassword', () => {
  const input = { password: 'new-pass-1', currentPassword: 'old-pass-1' };

  it('updates the user and clears the session without a logout request', async () => {
    mockedUsers.updateUser.mockResolvedValue(session);
    const client = createTestQueryClient();
    seedSession(client, session);

    const { result } = renderHook(() => useChangePassword(7), {
      wrapper: wrapper(client),
    });
    await result.current.mutateAsync(input);

    expect(mockedUsers.updateUser).toHaveBeenCalledWith(7, input);
    expect(client.getQueryData(queryKeys.session)).toBeNull();
  });

  it('keeps the session when the update fails', async () => {
    mockedUsers.updateUser.mockRejectedValue(new Error('nope'));
    const client = createTestQueryClient();
    seedSession(client, session);

    const { result } = renderHook(() => useChangePassword(7), {
      wrapper: wrapper(client),
    });
    await expect(result.current.mutateAsync(input)).rejects.toThrow('nope');

    expect(client.getQueryData(queryKeys.session)).toEqual(sessionOf(session));
  });
});

describe('useDeleteAvatar', () => {
  it('deletes and reports accountChanged', async () => {
    mockedUsers.deleteAvatar.mockResolvedValue(undefined);
    const client = createTestQueryClient();

    const { result } = renderHook(() => useDeleteAvatar(7), {
      wrapper: wrapper(client),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedUsers.deleteAvatar).toHaveBeenCalledWith(7);
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'accountChanged',
    });
  });

  it('reports nothing when the delete fails', async () => {
    mockedUsers.deleteAvatar.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useDeleteAvatar(7), {
      wrapper: wrapper(),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow('nope');

    expect(mockedApplyChange).not.toHaveBeenCalled();
  });
});
