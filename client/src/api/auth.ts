import { request } from './client';
import type {
  LoginPayload,
  RegisterPayload,
  ResetConfirmPayload,
  ResetRequestPayload,
} from 'shared';
import type { SessionUser } from '../types/api';

export const register = (input: RegisterPayload): Promise<SessionUser> => {
  return request<SessionUser>('/auth/register', {
    method: 'POST',
    body: input,
  });
};

export const login = (input: LoginPayload): Promise<SessionUser> => {
  return request<SessionUser>('/auth/login', { method: 'POST', body: input });
};

export const logout = (): Promise<void> => {
  return request<void>('/auth/logout', { method: 'POST' });
};

export const me = (): Promise<SessionUser> => {
  return request<SessionUser>('/auth/me');
};

export const requestReset = (email: string): Promise<void> => {
  return request<void>('/auth/password-reset/request', {
    method: 'POST',
    body: { email } satisfies ResetRequestPayload,
  });
};

export const confirmReset = (
  token: string,
  password: string
): Promise<void> => {
  return request<void>('/auth/password-reset/confirm', {
    method: 'POST',
    body: { token, password } satisfies ResetConfirmPayload,
  });
};
