import { col, fn, Op } from 'sequelize';
import { ILLUSTRATIONS_PER_CHAPTER_MAX, type PublicIllustration } from 'shared';
import { BookAuthor } from '../models/BookAuthor.ts';
import { Chapter } from '../models/Chapter.ts';
import type { ProcessedIllustration } from '../images.ts';
import { Illustration, toPublicIllustration } from '../models/Illustration.ts';
import { IllustrationImage } from '../models/IllustrationImage.ts';
import { NotFoundError, StateConflictError } from '../types/errors.ts';
import { sequelizeOf } from './sequelizeOf.ts';
import { readableChapterScope, type Viewer } from './visibility.ts';

export interface IllustrationRepository {
  // null when the chapter is missing or the viewer may not read it (same 404).
  list(chapterId: number, viewer: Viewer): Promise<PublicIllustration[] | null>;
  // null when the illustration is missing or its chapter is not readable.
  getImageData(id: number, viewer: Viewer): Promise<{ data: Buffer } | null>;
  // The Co-author ids of the illustration's book; null when it is missing.
  findCoAuthorIds(id: number): Promise<number[] | null>;
  // A cheap look at the cap, so an upload past it is refused before its image
  // is decoded. Unlocked; create() rechecks under the chapter lock.
  isFull(chapterId: number): Promise<boolean>;
  // Appends at the end of the chapter; 409 at ILLUSTRATIONS_PER_CHAPTER_MAX.
  create(
    chapterId: number,
    image: ProcessedIllustration
  ): Promise<PublicIllustration>;
  // null when the illustration is missing.
  updateCaption(
    id: number,
    caption: string | null
  ): Promise<PublicIllustration | null>;
  // Takes every id of the chapter once, first first; 409 changing nothing
  // when they are not exactly the current ones.
  reorder(
    chapterId: number,
    illustrationIds: number[]
  ): Promise<PublicIllustration[]>;
  // Whether a row went; its image cascades.
  remove(id: number): Promise<boolean>;
}

export const ILLUSTRATION_CAP_MESSAGE = `A chapter holds at most ${ILLUSTRATIONS_PER_CHAPTER_MAX} illustrations`;

async function coAuthorIdsOfBook(bookId: number): Promise<number[]> {
  const credits = await BookAuthor.findAll({
    where: { bookId },
    attributes: ['userId'],
  });
  return credits.map((credit) => credit.userId);
}

// An Illustration is as readable as its Chapter: the same scope as
// chapterRepository.findById.
async function isChapterReadable(
  chapterId: number,
  viewer: Viewer
): Promise<boolean> {
  const scope = await readableChapterScope(viewer);
  const chapter = await Chapter.findOne({
    where: { [Op.and]: [{ id: chapterId }, scope.where] },
    include: [scope.include],
    attributes: ['id'],
  });
  return chapter !== null;
}

export function createSequelizeIllustrationRepository(): IllustrationRepository {
  return {
    async list(chapterId, viewer) {
      if (!(await isChapterReadable(chapterId, viewer))) return null;

      // The bytes live in illustration_images, so no SELECT here can fetch them.
      const rows = await Illustration.findAll({
        where: { chapterId },
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      return rows.map(toPublicIllustration);
    },

    async getImageData(id, viewer) {
      const illustration = await Illustration.findByPk(id, {
        attributes: ['id', 'chapterId'],
      });
      if (!illustration) return null;
      if (!(await isChapterReadable(illustration.chapterId, viewer))) {
        return null;
      }

      const image = await IllustrationImage.findByPk(id);
      return image ? { data: image.data } : null;
    },

    async findCoAuthorIds(id) {
      const illustration = await Illustration.findByPk(id, {
        attributes: ['id', 'chapterId'],
      });
      if (!illustration) return null;

      const chapter = await Chapter.findByPk(illustration.chapterId, {
        attributes: ['id', 'bookId'],
      });
      if (!chapter) return null;

      return coAuthorIdsOfBook(chapter.bookId);
    },

    async isFull(chapterId) {
      return (
        (await Illustration.count({ where: { chapterId } })) >=
        ILLUSTRATIONS_PER_CHAPTER_MAX
      );
    },

    // The chapter row is locked so two uploads cannot both pass the cap or
    // share a position.
    async create(chapterId, image) {
      return sequelizeOf(Illustration).transaction(async (transaction) => {
        const chapter = await Chapter.findByPk(chapterId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!chapter) throw new NotFoundError('Chapter', chapterId);

        const where = { chapterId };
        if (
          (await Illustration.count({ where, transaction })) >=
          ILLUSTRATIONS_PER_CHAPTER_MAX
        ) {
          throw new StateConflictError(ILLUSTRATION_CAP_MESSAGE);
        }
        const last = await Illustration.max<number | null, Illustration>(
          'position',
          { where, transaction }
        );
        const row = await Illustration.create(
          {
            chapterId,
            position: (last ?? 0) + 1,
            caption: null,
            width: image.width,
            height: image.height,
          },
          { transaction }
        );
        await IllustrationImage.create(
          { illustrationId: row.id, data: image.data },
          { transaction }
        );
        return toPublicIllustration(row);
      });
    },

    async updateCaption(id, caption) {
      return sequelizeOf(Illustration).transaction(async (transaction) => {
        // Row lock: a concurrent delete waits for this transaction.
        const locked = await Illustration.findByPk(id, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!locked) return null;

        await Illustration.update({ caption }, { where: { id }, transaction });
        const row = await Illustration.findByPk(id, { transaction });
        return row ? toPublicIllustration(row) : null;
      });
    },

    async reorder(chapterId, illustrationIds) {
      return sequelizeOf(Illustration).transaction(async (transaction) => {
        const chapter = await Chapter.findByPk(chapterId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!chapter) throw new NotFoundError('Chapter', chapterId);

        // Locked as well as read, so a delete cannot slip between the
        // comparison and the write.
        const current = await Illustration.findAll({
          where: { chapterId },
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const currentIds = new Set(current.map((row) => row.id));
        const sameSet =
          new Set(illustrationIds).size === illustrationIds.length &&
          illustrationIds.length === currentIds.size &&
          illustrationIds.every((id) => currentIds.has(id));
        if (!sameSet) {
          throw new StateConflictError(
            'The illustrations of this chapter changed since you loaded them'
          );
        }

        // One statement: FIELD(id, …) is each id's 1-based place in the list.
        await Illustration.update(
          { position: fn('FIELD', col('id'), ...illustrationIds) },
          { where: { chapterId }, transaction, silent: true }
        );
        const rows = await Illustration.findAll({
          where: { chapterId },
          order: [['position', 'ASC']],
          transaction,
        });
        return rows.map(toPublicIllustration);
      });
    },

    async remove(id) {
      return (await Illustration.destroy({ where: { id } })) > 0;
    },
  };
}
