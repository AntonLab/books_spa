import type { RequestHandler } from 'express';
import type { ItemsResponse, PublicIllustration } from 'shared';
import { validatedBody, validatedParams } from '../middleware/validate.ts';
import {
  ILLUSTRATION_CAP_MESSAGE,
  type IllustrationRepository,
} from '../repositories/illustrationRepository.ts';
import { viewerOf } from '../repositories/visibility.ts';
import { processIllustrationImage } from '../images.ts';
import {
  NotFoundError,
  StateConflictError,
  UnsupportedMediaTypeError,
} from '../types/errors.ts';
import type {
  ReorderIllustrationsInput,
  UpdateIllustrationInput,
} from '../types/illustration.ts';
import { type CoAuthorGuard, MAY_CHANGE_CHAPTERS } from './coAuthorGuard.ts';
import { sendCover } from './coverResponse.ts';

// No try/catch anywhere below: the Express 5 router calls next(err) itself when
// a handler's promise rejects.
export function createIllustrationController(
  repository: IllustrationRepository,
  guard: CoAuthorGuard
) {
  return {
    list: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const items = await repository.list(id, viewerOf(req.user));
      if (!items) throw new NotFoundError('Chapter', id);
      res.json({ items } satisfies ItemsResponse<PublicIllustration>);
    },

    // The Co-author and cap checks run before decoding: a refused upload is
    // never decoded. create() rechecks the cap under the chapter lock.
    upload: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(req, { chapter: id }, MAY_CHANGE_CHAPTERS);
      if (!Buffer.isBuffer(req.body)) throw new UnsupportedMediaTypeError();
      if (await repository.isFull(id)) {
        throw new StateConflictError(ILLUSTRATION_CAP_MESSAGE);
      }

      const image = await processIllustrationImage(req.body);
      res.status(201).json(await repository.create(id, image));
    },

    update: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(
        req,
        { illustration: id },
        MAY_CHANGE_CHAPTERS
      );

      const { caption } = validatedBody<UpdateIllustrationInput>(req);
      const row = await repository.updateCaption(id, caption);
      if (!row) throw new NotFoundError('Illustration', id);
      res.json(row);
    },

    reorder: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(req, { chapter: id }, MAY_CHANGE_CHAPTERS);

      const { illustrationIds } = validatedBody<ReorderIllustrationsInput>(req);
      const items = await repository.reorder(id, illustrationIds);
      res.json({ items } satisfies ItemsResponse<PublicIllustration>);
    },

    remove: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      await guard.assertMayChange(
        req,
        { illustration: id },
        MAY_CHANGE_CHAPTERS
      );

      if (!(await repository.remove(id))) {
        throw new NotFoundError('Illustration', id);
      }
      res.status(204).end();
    },

    getImage: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const image = await repository.getImageData(id, viewerOf(req.user));
      if (!image) throw new NotFoundError('Illustration', id);
      sendCover(res, image);
    },
  } satisfies Record<string, RequestHandler>;
}
