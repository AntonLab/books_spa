import { NotFoundError } from '../types/errors.ts';
import type { ChapterSummary, PublicChapter } from 'shared';
import type {
  ChapterListResult,
  ChapterRepository,
} from './chapterRepository.ts';

export interface FakeChapterRepositoryOptions {
  // bookId -> its Co-author ids: which books exist, and who co-authors each.
  // A chapter has no owner of its own, so both ownership lookups read this.
  // Read, never written, so a caller may keep adding to the map.
  books?: ReadonlyMap<number, number[]>;
  // Records what the routes handed the repository: every create and update
  // input, and every reorder.
  inputs?: unknown[];
}

// An in-memory ChapterRepository for the route specs, held to the real one by
// chapterRepository.contract.testkit.ts on the parts the controllers rely on.
//
// The domain rules stay in the real repository and are covered against MySQL:
// every chapter is visible here, a publication time is stored as given with no
// rule on moving it, no version is compared, and a reorder is not checked
// against the book's chapters.
export function createFakeChapterRepository(
  options: FakeChapterRepositoryOptions = {}
): ChapterRepository {
  const { books = new Map(), inputs = [] } = options;
  const rows = new Map<number, PublicChapter>();
  // chapterId -> its place in the book's Reading order.
  const positions = new Map<number, number>();
  let nextId = 1;

  return {
    async create(input) {
      inputs.push(input);
      // Stands in for the book row the real repository locks, and reports
      // missing with this same NotFoundError.
      if (!books.has(input.bookId)) {
        throw new NotFoundError('Book', input.bookId);
      }

      const now = new Date();
      const chapter: PublicChapter = {
        id: nextId,
        bookId: input.bookId,
        title: input.title,
        text: input.text,
        publishedAt:
          input.publishedAt === null
            ? null
            : input.publishedAt === 'now'
              ? now
              : new Date(input.publishedAt),
        createdAt: now,
        updatedAt: now,
      };
      nextId += 1;
      // Appended after the book's last chapter.
      const last = Math.max(
        0,
        ...[...rows.values()]
          .filter((row) => row.bookId === chapter.bookId)
          .map((row) => positions.get(row.id) ?? 0)
      );
      rows.set(chapter.id, chapter);
      positions.set(chapter.id, last + 1);
      return chapter;
    },

    async list(query): Promise<ChapterListResult> {
      const matching = [...rows.values()]
        .filter(
          (row) =>
            (query.bookId === undefined || row.bookId === query.bookId) &&
            (!query.q ||
              row.title.includes(query.q) ||
              row.text.includes(query.q))
        )
        .sort(
          (a, b) =>
            (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0) ||
            a.id - b.id
        );

      return {
        // Mirrors the real repository, which leaves the body out of the SELECT
        // rather than stripping it after the fact.
        items: matching
          .slice(query.offset, query.offset + query.limit)
          .map(({ text: _text, ...summary }): ChapterSummary => summary),
        total: matching.length,
      };
    },

    async findById(id) {
      return rows.get(id) ?? null;
    },

    async update(id, input) {
      inputs.push(input);
      const current = rows.get(id);
      if (!current) return null;

      const updated: PublicChapter = {
        ...current,
        title: input.title ?? current.title,
        text: input.text ?? current.text,
        updatedAt: new Date(),
      };
      rows.set(id, updated);
      return updated;
    },

    async remove(id) {
      positions.delete(id);
      return rows.delete(id);
    },

    async reorder(bookId, chapterIds) {
      inputs.push({ bookId, chapterIds });
      if (!books.has(bookId)) return false;
      chapterIds.forEach((chapterId, index) => {
        if (rows.get(chapterId)?.bookId === bookId) {
          positions.set(chapterId, index + 1);
        }
      });
      return true;
    },

    // Mirrors the real repository, which resolves a chapter's Co-authors
    // through the book it is stored under.
    async findCoAuthorIds(id) {
      const chapter = rows.get(id);
      const coAuthorIds = chapter ? books.get(chapter.bookId) : undefined;
      return coAuthorIds ? [...coAuthorIds] : null;
    },
  };
}
