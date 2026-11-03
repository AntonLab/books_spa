import type { RequestHandler } from 'express';
import type { PublicUser, SessionUser } from 'shared';
import type { AccountSession } from '../accountSession.ts';
import { permissionsFor } from '../permissions/permissionStore.ts';
import { validatedBody } from '../middleware/validate.ts';
import type { SessionRepository } from '../repositories/sessionRepository.ts';
import type { UserRepository } from '../repositories/userRepository.ts';
import {
  clearSessionCookie,
  setSessionCookie,
  SESSION_COOKIE_NAME,
} from '../sessionCookie.ts';
import { hashToken } from '../tokens.ts';
import type {
  LoginInput,
  RegisterInput,
  ResetConfirmInput,
  ResetRequestInput,
} from '../types/auth.ts';
import { UnauthorizedError } from '../types/errors.ts';

export interface AuthControllerDeps {
  userRepository: UserRepository;
  sessionRepository: SessionRepository;
  accountSession: AccountSession;
}

const toSession = (user: PublicUser): SessionUser => ({
  ...user,
  permissions: permissionsFor(user.role),
});

export function createAuthController(deps: AuthControllerDeps) {
  return {
    register: async (req, res) => {
      const { user, token } = await deps.accountSession.register(
        validatedBody<RegisterInput>(req)
      );
      setSessionCookie(res, token);
      res.status(201).json(toSession(user));
    },

    login: async (req, res) => {
      const previous: unknown = req.cookies?.[SESSION_COOKIE_NAME];
      const { user, token } = await deps.accountSession.login(
        validatedBody<LoginInput>(req),
        typeof previous === 'string' && previous.length > 0 ? previous : null
      );
      setSessionCookie(res, token);
      res.json(toSession(user));
    },

    logout: async (req, res) => {
      const token: unknown = req.cookies?.[SESSION_COOKIE_NAME];
      if (typeof token === 'string' && token.length > 0) {
        await deps.sessionRepository.deleteByTokenHash(hashToken(token));
      }

      // 204 either way: logging out twice, or with a stale cookie, is not a
      // client error and must not be reported as one.
      clearSessionCookie(res);
      res.status(204).end();
    },

    me: async (req, res) => {
      // requireAuth guarantees this; the check narrows the optional type.
      if (!req.user) throw new UnauthorizedError();
      // req.user is the lean AuthUser; /me needs avatarUrl.
      const user = await deps.userRepository.findById(req.user.id);
      if (!user) throw new UnauthorizedError();
      res.json(toSession(user));
    },

    requestReset: async (req, res) => {
      const { email } = validatedBody<ResetRequestInput>(req);

      // 202 before any account-dependent work. Branching, or a lookup/token
      // write delaying the response, makes status or timing an enumeration
      // oracle.
      res.status(202).end();

      // Detached: the module never rejects, so nothing here can become a 500.
      void deps.accountSession.requestReset(email);
    },

    confirmReset: async (req, res) => {
      const { token, password } = validatedBody<ResetConfirmInput>(req);
      await deps.accountSession.confirmReset(token, password);
      res.status(204).end();
    },
  } satisfies Record<string, RequestHandler>;
}
