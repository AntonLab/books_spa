import { randomBytes } from 'node:crypto';
import { LOGIN_FORBIDDEN_CHARACTER } from 'shared';
import type { PublicUser } from 'shared';
import type { MailDelivery } from './delivery/mailDelivery.ts';
import { hashPassword } from './password.ts';
import type { PasswordResetRepository } from './repositories/passwordResetRepository.ts';
import type { SessionRepository } from './repositories/sessionRepository.ts';
import type { UserRepository } from './repositories/userRepository.ts';
import { SESSION_TTL_MS } from './sessionCookie.ts';
import { createToken, hashToken } from './tokens.ts';
import type { LoginInput, RegisterInput } from './types/auth.ts';
import { ForbiddenError, UnauthorizedError } from './types/errors.ts';

export type PasswordVerifier = (
  hashed: string,
  plaintext: string
) => Promise<boolean>;

export interface AccountSessionDeps {
  userRepository: UserRepository;
  sessionRepository: SessionRepository;
  passwordResetRepository: PasswordResetRepository;
  mailDelivery: MailDelivery;
  appBaseUrl: string;
  // Injectable so a test can prove the unknown-login path still spends an
  // argon2 verify: a wall-clock assertion would flake and an ESM import binding
  // cannot be spied on.
  verify: PasswordVerifier;
}

export interface OpenedSession {
  user: PublicUser;
  token: string;
}

export interface AccountSession {
  register(input: RegisterInput): Promise<OpenedSession>;
  // previousToken is the raw sid cookie value, or null without one.
  login(
    input: LoginInput,
    previousToken: string | null
  ): Promise<OpenedSession>;
}

// Computed lazily and cached, not hardcoded: hashPassword reads the argon2
// parameters from NODE_ENV, so tests get the deliberately weak settings and
// production gets the real ones. Verifying against this on an unknown login
// keeps the response time indistinguishable from a wrong password.
let dummyHash: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export function createAccountSession(deps: AccountSessionDeps): AccountSession {
  return {
    register: async ({ role, ...input }) => {
      // status is set here, not accepted from the body: the column defaults to
      // 'pending' and there is no verification flow to clear it, so a
      // registrant would otherwise be unable to log in.
      //
      // role travels as its own argument, so it cannot ride in with the rest of
      // the body on any other create path.
      const user = await deps.userRepository.create(
        { ...input, status: 'active' },
        role
      );

      // A brand-new account has nothing in flight that could invalidate the
      // session before it is written. login opens its own below.
      const token = createToken();
      await deps.sessionRepository.create(
        user.id,
        hashToken(token),
        new Date(Date.now() + SESSION_TTL_MS)
      );
      return { user, token };
    },

    login: async ({ login, password }, previousToken) => {
      // Logins cannot contain the character, so it picks the column.
      const credential = login.includes(LOGIN_FORBIDDEN_CHARACTER)
        ? await deps.userRepository.findByEmailWithPassword(login)
        : await deps.userRepository.findByLoginWithPassword(login);

      if (!credential) {
        // Burn the same argon2 cost a real verify would, so response timing
        // does not separate "no such user" from "wrong password".
        await deps.verify(await dummyPasswordHash(), password);
        throw new UnauthorizedError('Invalid credentials');
      }

      if (!(await deps.verify(credential.password, password))) {
        throw new UnauthorizedError('Invalid credentials');
      }

      // Checked after the password, not before: otherwise the 403 tells an
      // attacker without the password that the account exists.
      if (credential.status === 'blocked') {
        throw new ForbiddenError('Account is blocked');
      }

      const user = await deps.userRepository.findById(credential.id);
      if (!user) {
        throw new UnauthorizedError('Invalid credentials');
      }

      // Each login opens a fresh row and deletes the one its cookie names, so a
      // planted cookie cannot be fixed onto a session.
      //
      // Opened only if the account still holds the hash verified above and is
      // still not blocked. A password change or a block can commit while the
      // verify runs, and its session purge would then already be behind us —
      // see sessionRepository.createIfCredentialCurrent for how the re-check
      // closes that window.
      const token = createToken();
      const opening = await deps.sessionRepository.createIfCredentialCurrent(
        user.id,
        hashToken(token),
        new Date(Date.now() + SESSION_TTL_MS),
        credential.password,
        previousToken === null ? null : hashToken(previousToken)
      );
      if (opening === 'credential-changed') {
        throw new UnauthorizedError('Invalid credentials');
      }
      if (opening === 'blocked') {
        throw new ForbiddenError('Account is blocked');
      }

      // A login is a session's first request and carries no cookie yet, so
      // the auth middleware cannot stamp it.
      await deps.userRepository.touchLastSeen(user.id, new Date());
      return { user, token };
    },
  };
}
