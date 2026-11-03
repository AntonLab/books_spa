import express, { Router } from 'express';
import { ACCEPTED_IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from 'shared';
import { createBookController } from '../controllers/bookController.ts';
import { createCoAuthorGuard } from '../controllers/coAuthorGuard.ts';
import { createSeriesController } from '../controllers/seriesController.ts';
import { limitEveryRequestByUser } from '../middleware/authRateLimit.ts';
import { createRequireAuth } from '../middleware/requireAuth.ts';
import { createRequirePermission } from '../middleware/requirePermission.ts';
import { validate } from '../middleware/validate.ts';
import {
  createSeriesSchema,
  listSeriesQuerySchema,
  reorderSeriesBooksSchema,
  seriesBookParamSchema,
  updateSeriesSchema,
} from '../types/series.ts';
import {
  addCoAuthorSchema,
  coAuthorParamSchema,
  idParamSchema,
} from '../types/params.ts';
import type { RouteDeps } from './index.ts';

export function createSeriesRoutes(deps: RouteDeps): Router {
  const guard = createCoAuthorGuard(deps);
  const controller = createSeriesController(deps.seriesRepository, guard);
  const requirePermission = createRequirePermission(deps);
  const requireAuth = createRequireAuth(deps);
  const router = Router();

  // Every route runs through the matrix, reads included: `guest` has `read:
  // any` on series, which is what keeps the list and detail routes public.
  router.get(
    '/',
    requirePermission('series', 'read'),
    validate({ query: listSeriesQuerySchema }),
    controller.list
  );
  router.get(
    '/:id',
    requirePermission('series', 'read'),
    validate({ params: idParamSchema }),
    controller.getById
  );

  router.post(
    '/',
    requirePermission('series', 'create'),
    validate({ body: createSeriesSchema }),
    controller.create
  );
  router.patch(
    '/:id',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema, body: updateSeriesSchema }),
    controller.update
  );
  router.delete(
    '/:id',
    requirePermission('series', 'delete'),
    validate({ params: idParamSchema }),
    controller.remove
  );

  router.post(
    '/:id/co-authors',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema, body: addCoAuthorSchema }),
    controller.addCoAuthor
  );
  // Not requirePermission, for the reason bookRoutes gives: a Co-author who
  // switched Role to `user` holds `none` on series and must still be able to
  // leave. The controller decides who may remove whom.
  router.delete(
    '/:id/co-authors/:userId',
    requireAuth,
    validate({ params: coAuthorParamSchema }),
    controller.removeCoAuthor
  );

  router.delete(
    '/:id/books/:bookId',
    requirePermission('series', 'update'),
    validate({ params: seriesBookParamSchema }),
    controller.removeBook
  );

  // The raw body parser is mounted on this PUT alone, after requirePermission
  // so a refused request's 2 MiB is never read.
  router.put(
    '/:id/cover',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema }),
    limitEveryRequestByUser(deps.authRateLimits.upload),
    express.raw({
      type: [...ACCEPTED_IMAGE_CONTENT_TYPES],
      limit: IMAGE_MAX_BYTES,
    }),
    controller.uploadCover
  );
  router.delete(
    '/:id/cover',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema }),
    controller.removeCover
  );
  router.get(
    '/:id/cover',
    requirePermission('series', 'read'),
    validate({ params: idParamSchema }),
    controller.getCover
  );

  // The books of a series as its editor works with them — the full list,
  // drafts included, and its Series order. Handled by the book controller,
  // because both read and write books; both ride on `series × update`.
  const bookController = createBookController(deps.bookRepository, guard);
  router.get(
    '/:id/books',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema }),
    bookController.listInSeries
  );
  router.put(
    '/:id/book-order',
    requirePermission('series', 'update'),
    validate({ params: idParamSchema, body: reorderSeriesBooksSchema }),
    bookController.reorderInSeries
  );

  return router;
}
