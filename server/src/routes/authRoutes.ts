import { Router } from 'express';
import { createAuthController } from '../controllers/authController.ts';
import {
  limitEveryRequest,
  limitFailedLogins,
} from '../middleware/authRateLimit.ts';
import { createRequireAuth } from '../middleware/requireAuth.ts';
import { validate } from '../middleware/validate.ts';
import {
  loginSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
} from '../types/auth.ts';
import type { RouteDeps } from './index.ts';

export function createAuthRoutes(deps: RouteDeps): Router {
  const controller = createAuthController(deps);
  const requireAuth = createRequireAuth(deps);
  const limits = deps.authRateLimits;
  const router = Router();

  // Each limit runs ahead of validate, so a refused request costs no parsing,
  // no lookup and no argon2 (see middleware/authRateLimit.ts).
  router.post(
    '/register',
    limitEveryRequest(limits.register),
    validate({ body: registerSchema }),
    controller.register
  );
  router.post(
    '/login',
    limitFailedLogins(limits),
    validate({ body: loginSchema }),
    controller.login
  );
  // No requireAuth: logging out with an already-dead session is a success.
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth, controller.me);
  router.post(
    '/password-reset/request',
    limitEveryRequest(limits.resetRequest),
    validate({ body: resetRequestSchema }),
    controller.requestReset
  );
  router.post(
    '/password-reset/confirm',
    limitEveryRequest(limits.resetConfirm),
    validate({ body: resetConfirmSchema }),
    controller.confirmReset
  );

  return router;
}
