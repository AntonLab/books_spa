import { col, fn, Op } from 'sequelize';
import type { WhereOptions } from 'sequelize';
import { Book } from '../models/Book.ts';
import { BookAuthor } from '../models/BookAuthor.ts';
import {
  Chapter,
  toChapterSummary,
  toPublicChapter,
} from '../models/Chapter.ts';
import {
  BadRequestError,
  NotFoundError,
  StateConflictError,
} from '../types/errors.ts';
import type { ChapterSummary, PublicChapter } from 'shared';
import type {
  CreateChapterInput,
  ListChaptersQuery,
  PublishedAtInput,
  UpdateChapterInput,
} from '../types/chapter.ts';
import { containsPattern } from './likePattern.ts';
import { sequelizeOf } from './sequelizeOf.ts';
import { readableChapterScope, type Viewer } from './visibility.ts';

export interface ChapterListResult {
  // Summaries, not full records: see list() for why the body stays out of the
  // SELECT.
  items: ChapterSummary[];
  total: number;
}

export interface ChapterRepository {
  create(input: CreateChapterInput): Promise<PublicChapter>;
  // Both leave out what the viewer may not read: the chapters of a Draft book,
  // and — for anyone but the book's Co-authors and Moderators — every chapter
  // whose Publication time has not passed. A hidden chapter is reported
  // exactly as a missing one.
  list(query: ListChaptersQuery, viewer: Viewer): Promise<ChapterListResult>;
  findById(id: number, viewer: Viewer): Promise<PublicChapter | null>;
  update(id: number, input: UpdateChapterInput): Promise<PublicChapter | null>;
  remove(id: number): Promise<boolean>;
  // Rewrites the book's Reading order to `chapterIds`, which must name every
  // one of its chapters exactly once; anything else means the list was drawn
  // before a chapter was added or deleted, and is a StateConflictError that
  // changes nothing. False when the book is not there.
  reorder(bookId: number, chapterIds: number[]): Promise<boolean>;
  // The book's Co-author ids, or null when the chapter is not there.
  findCoAuthorIds(id: number): Promise<number[] | null>;
}

function buildWhere(query: ListChaptersQuery): WhereOptions {
  const clauses: WhereOptions[] = [];

  if (query.bookId !== undefined) {
    clauses.push({ bookId: query.bookId });
  }

  if (query.q) {
    // Searches the title as well as the body, so `?q=` finds a chapter by its
    // name. Both sides are a leading-wildcard LIKE and therefore a full scan —
    // unavoidable for substring search, and the same cost the books' `?q=`
    // already pays over its description.
    const pattern = containsPattern(query.q);
    clauses.push({
      [Op.or]: [
        { title: { [Op.like]: pattern } },
        { text: { [Op.like]: pattern } },
      ],
    });
  }

  return clauses.length > 0 ? { [Op.and]: clauses } : {};
}

async function findBookCoAuthorIds(bookId: number): Promise<number[] | null> {
  const book = await Book.findByPk(bookId, { attributes: ['id'] });
  if (!book) return null;

  const credits = await BookAuthor.findAll({
    where: { bookId },
    attributes: ['userId'],
  });
  return credits.map((credit) => credit.userId);
}

// Turns a save's publishedAt into the moment to store. `now` is the server's
// clock — the same clock every read compares against — so "publish
// immediately" means readable on the very next request. A moment at or before
// now is refused rather than stored: it would publish a chapter under a date
// it was never out on.
function resolvePublishedAt(value: PublishedAtInput, now: Date): Date | null {
  if (value === null) return null;
  if (value === 'now') return now;

  const at = new Date(value);
  if (at.getTime() <= now.getTime()) {
    throw new BadRequestError('A publication time cannot be in the past');
  }
  return at;
}

export function createSequelizeChapterRepository(): ChapterRepository {
  return {
    // Appends under a lock on the book row, which a reorder takes too: two
    // chapters added at once would otherwise read the same last position, and
    // one added during a reorder could land in the middle of it. The lock also
    // settles whether the book exists, so the foreign key is never the one to
    // say so.
    async create(input) {
      const { publishedAt, ...attributes } = input;
      const at = resolvePublishedAt(publishedAt, new Date());

      return sequelizeOf(Chapter).transaction(async (transaction) => {
        const book = await Book.findByPk(input.bookId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) throw new NotFoundError('Book', input.bookId);

        const last = await Chapter.max<number | null, Chapter>('position', {
          where: { bookId: input.bookId },
          transaction,
        });
        const chapter = await Chapter.create(
          { ...attributes, publishedAt: at, position: (last ?? 0) + 1 },
          { transaction }
        );
        return toPublicChapter(chapter);
      });
    },

    async list(query, viewer) {
      const scope = await readableChapterScope(viewer);
      const { rows, count } = await Chapter.findAndCountAll({
        // The body is left out of the SELECT rather than trimmed afterwards: a
        // page of twenty chapters would otherwise drag twenty MEDIUMTEXT
        // columns off disk and across the wire to be discarded.
        attributes: [
          'id',
          'bookId',
          'title',
          'publishedAt',
          'createdAt',
          'updatedAt',
        ],
        where: { [Op.and]: [buildWhere(query), scope.where] },
        include: [scope.include],
        limit: query.limit,
        offset: query.offset,
        // The Reading order, with id breaking a tie no write produces.
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
      });

      return { items: rows.map(toChapterSummary), total: count };
    },

    async findById(id, viewer) {
      const scope = await readableChapterScope(viewer);
      const chapter = await Chapter.findOne({
        where: { [Op.and]: [{ id }, scope.where] },
        include: [scope.include],
      });
      return chapter ? toPublicChapter(chapter) : null;
    },

    // Under a lock on the row, so the version check and the write cannot be
    // split by another save: without it two co-authors holding the same
    // updatedAt could both pass the comparison and the second would still
    // overwrite the first.
    async update(id, input) {
      return sequelizeOf(Chapter).transaction(async (transaction) => {
        const chapter = await Chapter.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!chapter) return null;

        const { expectedUpdatedAt, publishedAt, ...fields } = input;
        if (
          chapter.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()
        ) {
          throw new StateConflictError(
            'This chapter was changed since you loaded it'
          );
        }

        const changes: Partial<{
          title: string;
          text: string;
          publishedAt: Date | null;
        }> = { ...fields };

        if (publishedAt !== undefined) {
          const now = new Date();
          const isPublished =
            chapter.publishedAt !== null &&
            chapter.publishedAt.getTime() <= now.getTime();
          // A Published chapter's moment is history: it may only go back to
          // Draft, and publishing it again then sets a fresh one. Moving it
          // directly would re-date a chapter readers have already seen.
          if (isPublished && publishedAt !== null) {
            throw new BadRequestError(
              'A published chapter cannot be rescheduled; return it to draft first'
            );
          }
          changes.publishedAt = resolvePublishedAt(publishedAt, now);
        }

        // No FK mapping here, unlike books: bookId is absent from
        // updateChapterSchema, so an update cannot violate the constraint.
        await chapter.update(changes, { transaction });
        return toPublicChapter(chapter);
      });
    },

    async remove(id) {
      const deleted = await Chapter.destroy({ where: { id } });
      return deleted > 0;
    },

    async reorder(bookId, chapterIds) {
      return sequelizeOf(Chapter).transaction(async (transaction) => {
        const book = await Book.findByPk(bookId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) return false;

        // Locked as well as read, so a delete cannot slip between the
        // comparison and the write.
        const current = await Chapter.findAll({
          where: { bookId },
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const currentIds = new Set(current.map((chapter) => chapter.id));
        const sameSet =
          new Set(chapterIds).size === chapterIds.length &&
          chapterIds.length === currentIds.size &&
          chapterIds.every((chapterId) => currentIds.has(chapterId));
        if (!sameSet) {
          throw new StateConflictError(
            'The chapters of this book changed since you loaded them'
          );
        }

        // One statement: FIELD(id, …) is each id's 1-based place in the list.
        // Silent, so no chapter's updatedAt moves — a reorder is not an edit,
        // and a Co-author with a chapter open would otherwise get a 409 for
        // text nobody touched.
        await Chapter.update(
          { position: fn('FIELD', col('id'), ...chapterIds) },
          { where: { bookId }, transaction, silent: true }
        );
        return true;
      });
    },

    async findCoAuthorIds(id) {
      const chapter = await Chapter.findByPk(id, { attributes: ['bookId'] });
      return chapter ? findBookCoAuthorIds(chapter.bookId) : null;
    },
  };
}
