import express, { Router, type Request } from 'express';
import { ACCEPTED_IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from 'shared';
import { createCoAuthorGuard } from '../controllers/coAuthorGuard.ts';
import { createChapterController } from '../controllers/chapterController.ts';
import { createIllustrationController } from '../controllers/illustrationController.ts';
import { limitUserWrites } from '../middleware/authRateLimit.ts';
import { createRequirePermission } from '../middleware/requirePermission.ts';
import { validate } from '../middleware/validate.ts';
import {
  createChapterSchema,
  listChaptersQuerySchema,
  updateChapterSchema,
} from '../types/chapter.ts';
import { reorderIllustrationsSchema } from '../types/illustration.ts';
import { idParamSchema } from '../types/params.ts';
import type { RouteDeps } from './index.ts';

// A chapter text is up to CHAPTER_TEXT_MAX_LENGTH characters, up to 4 bytes
// each, plus the JSON envelope.
export const CHAPTER_JSON_LIMIT_BYTES = 5 * 1024 * 1024;

// The two writes below that parse chapterJson, as app.ts sees them under
// /api: it keeps the global parser off them. Case-insensitive like Express's
// own routing, so no spelling of the path escapes the permission check.
export const isChapterTextWrite = (req: Request): boolean =>
  (req.method === 'POST' && /^\/api\/chapters\/?$/i.test(req.path)) ||
  (req.method === 'PATCH' && /^\/api\/chapters\/[^/]+\/?$/i.test(req.path));

export function createChapterRoutes(deps: RouteDeps): Router {
  const guard = createCoAuthorGuard(deps);
  const controller = createChapterController(deps.chapterRepository, guard);
  const illustrations = createIllustrationController(
    deps.illustrationRepository,
    guard
  );
  const requirePermission = createRequirePermission(deps);
  const limitWrites = limitUserWrites(deps);
  const router = Router();
  // app.ts keeps the global parser off these two writes, so the large limit
  // applies only after requirePermission: an unauthorised caller never has
  // its body read.
  const chapterJson = express.json({ limit: CHAPTER_JSON_LIMIT_BYTES });

  // Every route runs through the matrix, reads included: every role has
  // `read: any` on chapters, which is what keeps the list and detail routes
  // public.
  router.get(
    '/',
    requirePermission('chapters', 'read'),
    validate({ query: listChaptersQuerySchema }),
    controller.list
  );
  router.get(
    '/:id',
    requirePermission('chapters', 'read'),
    validate({ params: idParamSchema }),
    controller.getById
  );
  router.get(
    '/:id/illustrations',
    requirePermission('chapters', 'read'),
    validate({ params: idParamSchema }),
    illustrations.list
  );

  router.post(
    '/',
    requirePermission('chapters', 'create'),
    chapterJson,
    validate({ body: createChapterSchema }),
    limitWrites,
    controller.create
  );
  // Raw parser after permission and params, so those failures never read the
  // body.
  router.post(
    '/:id/illustrations',
    requirePermission('chapters', 'update'),
    validate({ params: idParamSchema }),
    express.raw({
      type: [...ACCEPTED_IMAGE_CONTENT_TYPES],
      limit: IMAGE_MAX_BYTES,
    }),
    illustrations.upload
  );
  router.put(
    '/:id/illustration-order',
    requirePermission('chapters', 'update'),
    validate({ params: idParamSchema, body: reorderIllustrationsSchema }),
    illustrations.reorder
  );
  router.patch(
    '/:id',
    requirePermission('chapters', 'update'),
    chapterJson,
    validate({ params: idParamSchema, body: updateChapterSchema }),
    limitWrites,
    controller.update
  );
  router.delete(
    '/:id',
    requirePermission('chapters', 'delete'),
    validate({ params: idParamSchema }),
    limitWrites,
    controller.remove
  );

  return router;
}
