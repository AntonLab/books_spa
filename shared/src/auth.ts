import type { RegistrableRole } from './role.ts';

// The sign-up POST body.
export interface RegisterPayload {
  login: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  // The only role a public form may ask for. The server narrows it again, so
  // this is a convenience, not the guard.
  role?: RegistrableRole;
}

// The sign-in POST body. `login` also accepts an email.
export interface LoginPayload {
  login: string;
  password: string;
}

// The forgot-password POST body.
export interface ResetRequestPayload {
  email: string;
}

// The reset-password POST body: the emailed token and the new password.
export interface ResetConfirmPayload {
  token: string;
  password: string;
}
