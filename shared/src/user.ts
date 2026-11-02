import type { UserRole } from './role.ts';

// `as const` union rather than an enum, per the repository rules.
export const USER_STATUSES = ['active', 'blocked', 'pending'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// The password is absent by construction: it must never reach a response.
export interface PublicUser {
  id: number;
  login: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  role: UserRole;
  // The same versioned-URL shape as a Book's Cover.
  avatarUrl: string | null;
  // The Account form reads both from the session. An empty About means none.
  about: string;
  showLastSeen: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// The Account's own writes. `status` is deliberately absent: it is
// Moderator-only, and `blockUser` sends it inline.
export interface UpdateUserPayload {
  login?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  currentPassword?: string;
  about?: string;
  showLastSeen?: boolean;
}

// Where the emailed reset link lands: the server builds the link from it, and
// the client routes it and reads the token there.
export const PASSWORD_RESET_PATH = '/reset-password';

// The longest term the Co-author picker's search accepts. The server refuses a
// longer `q` with a 400, so the client stops typing here instead of showing
// "No authors found" for a search that never ran.
export const AUTHOR_SEARCH_MAX_LENGTH = 64;

// The account fields' length limits. The server's zod schemas and the client's
// forms read these same numbers, so a limit changes in one place and a form
// never accepts what the API would refuse. A name's minimum is 1 and stays in
// the schemas.
export const LOGIN_MIN_LENGTH = 3;
export const LOGIN_MAX_LENGTH = 64;
// Sign-in treats a value with this character as an email, so a login must not contain it.
export const LOGIN_FORBIDDEN_CHARACTER = '@';
export const LOGIN_FORBIDDEN_CHARACTER_MESSAGE = 'Login cannot contain @';
export const NAME_MAX_LENGTH = 64;
// The column width of `users.email`.
export const EMAIL_MAX_LENGTH = 255;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
// The client checks the same number for the About text.
export const ABOUT_MAX_LENGTH = 1000;
// How long a last-seen stamp stays fresh: the server stamps at most once per
// window, and the client calls a stamp within it "Online now".
export const LAST_ONLINE_WINDOW_MS = 300000;

// PublicUser minus the email, plus `status`. Without the email an author is
// safe to embed in a public response: the email is why /api/users is guarded.
// `status` lets a client tell whether the name links.
export interface AuthorSummary {
  id: number;
  login: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  avatarUrl: string | null;
}
