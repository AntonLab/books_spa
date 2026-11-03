import type { RequestHandler } from 'express';
import { processCoverImage } from '../images.ts';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middleware/validate.ts';
import {
  assertMayChange,
  type CoAuthorGuard,
  type CoAuthorTarget,
} from './coAuthorGuard.ts';
import { sendCover } from './coverResponse.ts';
import { creditHandlers } from './creditHandlers.ts';
import type { SeriesRepository } from '../repositories/seriesRepository.ts';
import { actorOf, viewerOf } from '../repositories/visibility.ts';
import {
  NotFoundError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from '../types/errors.ts';
import type {
  CreateSeriesInput,
  ListSeriesQuery,
  UpdateSeriesInput,
} from '../types/series.ts';

// No try/catch anywhere below: the Express 5 router inspects the returned
// promise and calls next(err) itself when it rejects.
export function createSeriesController(
  repository: SeriesRepository,
  guard: CoAuthorGuard
) {
  // Row-level checks go through coAuthorGuard.ts, which holds the rule.
  const seriesTarget = (id: number): CoAuthorTarget => ({
    resource: 'Series',
    id,
    coAuthorIds: () => repository.findCoAuthorIds(id),
  });
  const MAY_ONLY_CHANGE_OWN = 'You may only change series you co-author';

  return {
    create: async (req, res) => {
      if (!req.user) throw new UnauthorizedError();

      // The first Co-author comes from the session, never the body —
      // otherwise an author could create a series credited to someone else
      // and the co-author rule above would mean nothing.
      const series = await repository.create({
        ...validatedBody<CreateSeriesInput>(req),
        userId: req.user.id,
      });
      res.status(201).json(series);
    },

    list: async (req, res) => {
      const query = validatedQuery<ListSeriesQuery>(req);
      if (query.favoritedBy !== undefined && !req.user) {
        throw new UnauthorizedError();
      }
      const { items, total } = await repository.list(query, viewerOf(req.user));
      res.json({ items, total, limit: query.limit, offset: query.offset });
    },

    getById: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const series = await repository.findDetailById(id, viewerOf(req.user));
      if (!series) throw new NotFoundError('Series', id);
      res.json(series);
    },

    update: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await assertMayChange(req, seriesTarget(id), MAY_ONLY_CHANGE_OWN);

      const series = await repository.update(
        id,
        validatedBody<UpdateSeriesInput>(req)
      );
      if (!series) throw new NotFoundError('Series', id);
      res.json(series);
    },

    remove: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await assertMayChange(req, seriesTarget(id), MAY_ONLY_CHANGE_OWN);

      const deleted = await repository.remove(id, actorOf(req));
      if (!deleted) throw new NotFoundError('Series', id);
      res.status(204).end();
    },

    ...creditHandlers({
      guard,
      kind: 'series',
      refusal: MAY_ONLY_CHANGE_OWN,
      repository,
    }),

    // Taking a book out changes the series, so it is the series that answers:
    // one of its Co-authors, or a Moderator under `any`. The book's own
    // Co-authors leave through PATCH /api/books/:id with `seriesId: null`.
    removeBook: async (req, res) => {
      const { id, bookId } = validatedParams<{ id: number; bookId: number }>(
        req
      );
      await assertMayChange(req, seriesTarget(id), MAY_ONLY_CHANGE_OWN);

      const removed = await repository.removeBook(id, bookId);
      if (!removed) throw new NotFoundError('Series', id);
      res.status(204).end();
    },

    // Series x update, then the same Co-author check PATCH uses.
    uploadCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      if (!Buffer.isBuffer(req.body)) {
        throw new UnsupportedMediaTypeError();
      }
      await assertMayChange(req, seriesTarget(id), MAY_ONLY_CHANGE_OWN);

      const processed = await processCoverImage(req.body);
      const found = await repository.setCover(id, processed);
      if (!found) throw new NotFoundError('Series', id);

      const series = await repository.findById(id, viewerOf(req.user));
      if (!series) throw new NotFoundError('Series', id);
      res.json(series);
    },

    // 204 whether or not a Cover existed, 404 for a missing Series.
    removeCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await assertMayChange(req, seriesTarget(id), MAY_ONLY_CHANGE_OWN);

      const found = await repository.removeCover(id);
      if (!found) throw new NotFoundError('Series', id);
      res.status(204).end();
    },

    // Rides on series x read, which a guest holds; a Series the viewer may not
    // see is the same 404 as a missing one.
    getCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const cover = await repository.getCoverData(id, viewerOf(req.user));
      if (!cover) throw new NotFoundError('Series', id);
      sendCover(res, cover);
    },
  } satisfies Record<string, RequestHandler>;
}
