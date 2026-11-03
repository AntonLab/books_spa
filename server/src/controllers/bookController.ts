import type { Request, RequestHandler } from 'express';
import type { ItemsResponse, SeriesBookSummary } from 'shared';
import { processCoverImage } from '../images.ts';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middleware/validate.ts';
import type { CoAuthorGuard } from './coAuthorGuard.ts';
import { sendCover } from './coverResponse.ts';
import { creditHandlers } from './creditHandlers.ts';
import type { BookRepository } from '../repositories/bookRepository.ts';
import { actorOf, viewerOf } from '../repositories/visibility.ts';
import {
  NotFoundError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from '../types/errors.ts';
import type {
  CreateBookInput,
  ListBooksQuery,
  UpdateBookInput,
} from '../types/book.ts';
import type { ReorderSeriesBooksInput } from '../types/series.ts';

// No try/catch anywhere below: the Express 5 router inspects the returned
// promise and calls next(err) itself when it rejects.
export function createBookController(
  repository: BookRepository,
  guard: CoAuthorGuard
) {
  const MAY_ONLY_CHANGE_OWN = 'You may only change books you co-author';

  // Filing a book under a series changes that series too — it starts listing
  // the book — so the caller must co-author the series as well as the book.
  // The two Co-author lists are independent: a book credited to A and B may sit
  // in a series credited to A and C, and only A may file it there. Without
  // this an author could put their book into a stranger's series.
  // chapterController closes the same hole one level down.
  //
  // null (unlinking) and an absent key (leaving the link alone) touch no
  // series, so neither needs a check. An absent series is still a 404 that
  // blames the series, and it comes before the 403, as everywhere else.
  const assertMayAddToSeries = async (
    req: Request,
    seriesId: number | null | undefined
  ): Promise<void> => {
    if (seriesId === null || seriesId === undefined) return;
    // A series' Co-authors, or a Moderator under `any`, may change which books
    // it holds and their order.
    await guard.assertMayChange(
      req,
      { series: seriesId },
      'You may only add books to series you co-author'
    );
  };

  return {
    create: async (req, res) => {
      if (!req.user) throw new UnauthorizedError();

      const input = validatedBody<CreateBookInput>(req);
      await assertMayAddToSeries(req, input.seriesId);

      // The first Co-author comes from the session, never the body — otherwise
      // an author could create a book credited to someone else and the
      // co-author rule above would mean nothing.
      const book = await repository.create({ ...input, userId: req.user.id });
      res.status(201).json(book);
    },

    list: async (req, res) => {
      const query = validatedQuery<ListBooksQuery>(req);
      if (query.favoritedBy !== undefined && !req.user) {
        throw new UnauthorizedError();
      }
      const { items, total, current } = await repository.list(
        query,
        viewerOf(req.user)
      );
      res.json({ items, total, current, pageSize: query.pageSize });
    },

    getById: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      // requirePermission fills req.user when a session cookie resolves and
      // leaves it unset otherwise — `guest` has `read: any` on books, so an
      // anonymous read still gets here. The viewer decides whether a Draft
      // book is readable at all — a hidden one is the same 404 as a missing
      // one — and a Guest's null is what makes viewerLikeId come back empty.
      const book = await repository.findDetailById(id, viewerOf(req.user));
      if (!book) throw new NotFoundError('Book', id);
      res.json(book);
    },

    update: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const input = validatedBody<UpdateBookInput>(req);
      // The book first: a caller who may not touch it learns nothing about
      // the series they named.
      await guard.assertMayChange(req, { book: id }, MAY_ONLY_CHANGE_OWN);
      await assertMayAddToSeries(req, input.seriesId);

      const book = await repository.update(id, input);
      if (!book) throw new NotFoundError('Book', id);
      res.json(book);
    },

    remove: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(req, { book: id }, MAY_ONLY_CHANGE_OWN);

      const deleted = await repository.remove(id, actorOf(req));
      if (!deleted) throw new NotFoundError('Book', id);
      res.status(204).end();
    },

    ...creditHandlers({
      guard,
      kind: 'book',
      refusal: MAY_ONLY_CHANGE_OWN,
      repository,
    }),

    // The series editor's list, mounted behind `series × update`: it names the
    // Draft books filed in the series, which only the people who may reorder
    // them need to see.
    listInSeries: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(
        req,
        { series: id },
        'You may only see the books of series you co-author'
      );

      const items = await repository.listInSeries(id);
      if (!items) throw new NotFoundError('Series', id);
      res.json({ items } satisfies ItemsResponse<SeriesBookSummary>);
    },

    reorderInSeries: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(
        req,
        { series: id },
        'You may only reorder the books of series you co-author'
      );

      const { bookIds } = validatedBody<ReorderSeriesBooksInput>(req);
      const found = await repository.reorderInSeries(id, bookIds);
      if (!found) throw new NotFoundError('Series', id);
      res.status(204).end();
    },

    // Books x update, then the same Co-author check PATCH uses.
    uploadCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      if (!Buffer.isBuffer(req.body)) {
        throw new UnsupportedMediaTypeError();
      }
      await guard.assertMayChange(req, { book: id }, MAY_ONLY_CHANGE_OWN);

      const processed = await processCoverImage(req.body);
      const found = await repository.setCover(id, processed);
      if (!found) throw new NotFoundError('Book', id);

      const book = await repository.findById(id);
      if (!book) throw new NotFoundError('Book', id);
      res.json(book);
    },

    // Same guards as uploadCover; 204 whether or not a Cover existed, but
    // 404 for a missing Book. The repository's report still counts: the row
    // can vanish between the guard's lookup and the write.
    removeCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(req, { book: id }, MAY_ONLY_CHANGE_OWN);

      const found = await repository.removeCover(id);
      if (!found) throw new NotFoundError('Book', id);
      res.status(204).end();
    },

    // Rides on books x read, which a guest holds; goes through the
    // repository's own readableBookWhere, so a Draft book's Cover is a 404
    // to anyone who may not read the book — the same 404 as a missing one.
    getCover: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const cover = await repository.getCoverData(id, viewerOf(req.user));
      if (!cover) throw new NotFoundError('Book', id);
      sendCover(res, cover);
    },
  } satisfies Record<string, RequestHandler>;
}
