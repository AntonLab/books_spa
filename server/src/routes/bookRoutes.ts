import express, { Router } from 'express';
import { createBookController } from '../controllers/bookController.ts';
import { createCoAuthorGuard } from '../controllers/coAuthorGuard.ts';
import { createChapterController } from '../controllers/chapterController.ts';
import { createLibraryController } from '../controllers/libraryController.ts';
import {
  limitEveryRequestByUser,
  limitUserWrites,
} from '../middleware/authRateLimit.ts';
import { createRequireAuth } from '../middleware/requireAuth.ts';
import { createRequirePermission } from '../middleware/requirePermission.ts';
import { validate } from '../middleware/validate.ts';
import {
  createBookSchema,
  listBooksQuerySchema,
  updateBookSchema,
} from '../types/book.ts';
import { reorderChaptersSchema } from '../types/chapter.ts';
import { readingProgressSchema } from '../types/library.ts';
import {
  addCoAuthorSchema,
  coAuthorParamSchema,
  idParamSchema,
} from '../types/params.ts';
import { ACCEPTED_IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from 'shared';
import type { RouteDeps } from './index.ts';

export function createBookRoutes(deps: RouteDeps): Router {
  const guard = createCoAuthorGuard(deps);
  const controller = createBookController(deps.bookRepository, guard);
  const requirePermission = createRequirePermission(deps);
  const requireAuth = createRequireAuth(deps);
  const router = Router();

  // Every route runs through the matrix, reads included: `guest` has `read:
  // any` on books, which is what keeps the list and detail routes public.
  router.get(
    '/',
    requirePermission('books', 'read'),
    validate({ query: listBooksQuerySchema }),
    controller.list
  );
  // requirePermission resolves the session itself
  // and sets req.user whenever one exists, so the detail handler still fills
  // in viewerLikeId for a signed-in caller.
  router.get(
    '/:id',
    requirePermission('books', 'read'),
    validate({ params: idParamSchema }),
    controller.getById
  );

  router.post(
    '/',
    requirePermission('books', 'create'),
    validate({ body: createBookSchema }),
    controller.create
  );
  router.patch(
    '/:id',
    requirePermission('books', 'update'),
    validate({ params: idParamSchema, body: updateBookSchema }),
    controller.update
  );
  router.delete(
    '/:id',
    requirePermission('books', 'delete'),
    validate({ params: idParamSchema }),
    controller.remove
  );

  // Crediting a co-author changes the book, so it rides on `books × update`;
  // the controller then refuses a Moderator, whose `any` reaches every book
  // but not its byline.
  router.post(
    '/:id/co-authors',
    requirePermission('books', 'update'),
    validate({ params: idParamSchema, body: addCoAuthorSchema }),
    controller.addCoAuthor
  );
  // Not requirePermission: leaving a book must not depend on a books grant,
  // because a Co-author who switched Role to `user` holds `none` there and
  // would otherwise be stuck on the byline. Any session gets through; the
  // controller decides who may remove whom.
  router.delete(
    '/:id/co-authors/:userId',
    requireAuth,
    validate({ params: coAuthorParamSchema }),
    controller.removeCoAuthor
  );

  // The raw body parser is mounted on this PUT alone, never
  // app-wide, and after requirePermission so a refused request's 2 MiB is
  // never read.
  router.put(
    '/:id/cover',
    requirePermission('books', 'update'),
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
    requirePermission('books', 'update'),
    validate({ params: idParamSchema }),
    controller.removeCover
  );
  // Books x read, which a guest holds — the same public-read pattern as
  // GET /:id.
  router.get(
    '/:id/cover',
    requirePermission('books', 'read'),
    validate({ params: idParamSchema }),
    controller.getCover
  );

  // A book's Reading order: it belongs to the book as a whole, but it is a
  // change to the book's chapters, so the chapter controller handles it and
  // it takes exactly the permission editing them does.
  router.put(
    '/:id/chapter-order',
    requirePermission('chapters', 'update'),
    validate({ params: idParamSchema, body: reorderChaptersSchema }),
    createChapterController(deps.chapterRepository, guard).reorder
  );

  // Reading progress is the caller's own Library state, so requireAuth rather
  // than the matrix; the Library repository owns the rules.
  router.post(
    '/:id/reading-progress',
    requireAuth,
    validate({ params: idParamSchema, body: readingProgressSchema }),
    limitUserWrites(deps),
    createLibraryController(deps.libraryRepository).recordProgress
  );

  return router;
}
