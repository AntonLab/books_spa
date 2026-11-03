import { Router } from 'express';
import { createCoAuthorGuard } from '../controllers/coAuthorGuard.ts';
import { createIllustrationController } from '../controllers/illustrationController.ts';
import { createRequirePermission } from '../middleware/requirePermission.ts';
import { validate } from '../middleware/validate.ts';
import { updateIllustrationSchema } from '../types/illustration.ts';
import { idParamSchema } from '../types/params.ts';
import type { RouteDeps } from './index.ts';

export function createIllustrationRoutes(deps: RouteDeps): Router {
  const controller = createIllustrationController(
    deps.illustrationRepository,
    createCoAuthorGuard(deps)
  );
  const requirePermission = createRequirePermission(deps);
  const router = Router();

  router.get(
    '/:id/image',
    requirePermission('chapters', 'read'),
    validate({ params: idParamSchema }),
    controller.getImage
  );

  router.patch(
    '/:id',
    requirePermission('chapters', 'update'),
    validate({ params: idParamSchema, body: updateIllustrationSchema }),
    controller.update
  );
  router.delete(
    '/:id',
    requirePermission('chapters', 'update'),
    validate({ params: idParamSchema }),
    controller.remove
  );

  return router;
}
