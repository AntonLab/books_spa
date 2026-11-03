import { NotFoundError } from '../types/errors.ts';
import { EMPTY_LIBRARY_COUNTS } from 'shared';
import type {
  BookDetail,
  BookSeriesRef,
  LibraryCounts,
  ReadingStatus,
  PublicBook,
  PublicGenre,
  AuthorSummary,
} from 'shared';
import type { BookListResult, BookRepository } from './bookRepository.ts';
import { missingGenre } from './genreRepository.ts';
import type { Actor } from './notificationRepository.ts';
import type { Viewer } from './visibility.ts';

// A series as the fake knows it: enough to answer who co-authors it and what a
// book's detail calls it.
export interface FakeSeries {
  title: string;
  coAuthorIds: number[];
}

export interface FakeBookRepositoryOptions {
  // The accounts that exist, by id. Stands in for users.id: a credit naming
  // anyone else is refused, and a response's `authors` carries these
  // summaries.
  accounts?: ReadonlyMap<number, AuthorSummary>;
  // The series that exist, by id. Read, never written, so a caller may keep
  // adding to the map after the fake is made.
  series?: ReadonlyMap<number, FakeSeries>;
  // The Genres that exist, by id. Read, never written, so a caller may keep
  // adding to the map after the fake is made — as with `series` above.
  genres?: ReadonlyMap<number, PublicGenre>;
  // What a book's detail reports about its likes, which live in another
  // repository: the count, and the id of a signed-in viewer's own like.
  likes?: { count: number; viewerLikeId: number | null };
  // What a book's detail reports about its Favorites, which live in another
  // repository: the count, and the id of a signed-in viewer's own Favorite.
  // Whether a Draft book counts is the real repository's rule, proven on MySQL.
  favorites?: { count: number; viewerFavoriteId: number | null };
  // What a book's detail reports about its Libraries, which live in another
  // repository: the counts, and a signed-in viewer's own Reading status.
  library?: { counts: LibraryCounts; viewerStatus: ReadingStatus | null };
  // What a book's detail reports from its comments and chapters, which live in
  // other repositories. Which comments and chapters count is the real
  // repository's rule, proven on MySQL.
  tallies?: { commentCount: number; wordCount: number };
  // Spies. `viewers` collects who each read was made as, `reorders` each
  // Series order handed over, `actors` who made each credit change or delete.
  viewers?: Viewer[];
  reorders?: { seriesId: number; bookIds: number[] }[];
  actors?: [string, Actor][];
}

// An in-memory BookRepository for the route specs, held to the real one by
// bookRepository.contract.testkit.ts on the parts the controllers rely on.
//
// The domain rules stay in the real repository and are covered against MySQL:
// Draft books are readable by everyone here, credits are not checked against
// the Author role, duplicates or the last Co-author, a reorder is not compared
// with the series' books, and nobody is notified.
export function createFakeBookRepository(
  options: FakeBookRepositoryOptions = {}
): BookRepository {
  const {
    accounts = new Map(),
    series = new Map(),
    genres = new Map(),
    likes = { count: 0, viewerLikeId: null },
    favorites = { count: 0, viewerFavoriteId: null },
    library = { counts: EMPTY_LIBRARY_COUNTS, viewerStatus: null },
    tallies = { commentCount: 0, wordCount: 0 },
    viewers = [],
    reorders = [],
    actors = [],
  } = options;
  const rows = new Map<number, PublicBook>();
  // bookId -> its stored Cover. Visibility is the real repository's domain
  // rule (readableBookWhere) — the fake stays rule-free and answers for
  // whatever book exists in `rows`, mirroring findById.
  const covers = new Map<number, { data: Buffer; updatedAt: Date }>();
  // bookId -> co-author ids, in credit order.
  const credits = new Map<number, number[]>();
  // bookId -> its place in the Series order, for a book filed in a series.
  const positions = new Map<number, number>();
  let nextId = 1;

  // Mirrors loadCoverUrls in the real repository (it reads the
  // fake's own covers map, no visibility rule attached), so a route spec can
  // see coverUrl change after a PUT/DELETE on /:id/cover.
  const coverUrlOf = (bookId: number): string | null => {
    const cover = covers.get(bookId);
    return cover
      ? `/api/books/${bookId}/cover?v=${cover.updatedAt.getTime()}`
      : null;
  };

  // Mirrors loadSeriesRefs in the real repository: N counts Published books in
  // Series order, and a Draft row gets null.
  const seriesRefOf = (book: PublicBook): BookSeriesRef | null => {
    const filedIn =
      book.seriesId === null ? undefined : series.get(book.seriesId);
    if (book.seriesId === null || filedIn === undefined) return null;
    const place =
      inSeriesOrder(book.seriesId)
        .filter((row) => row.status !== 'draft')
        .findIndex((row) => row.id === book.id) + 1;
    return {
      id: book.seriesId,
      title: filedIn.title,
      position: book.status === 'draft' || place === 0 ? null : place,
    };
  };

  const withCredits = (book: PublicBook): PublicBook => ({
    ...book,
    authors: (credits.get(book.id) ?? []).flatMap(
      (id) => accounts.get(id) ?? []
    ),
    coverUrl: coverUrlOf(book.id),
    series: seriesRefOf(book),
  });

  // Stands in for the series row's foreign key, which the real repository
  // reports as this same NotFoundError before it writes.
  const assertSeries = (seriesId: number | null | undefined): void => {
    if (seriesId !== null && seriesId !== undefined && !series.has(seriesId)) {
      throw new NotFoundError('Series', seriesId);
    }
  };

  // Stands in for the genres row the real repository looks up before it
  // writes, which answers a missing one with this same BadRequestError.
  const assertGenre = (genreId: number | null | undefined): void => {
    if (genreId !== null && genreId !== undefined && !genres.has(genreId)) {
      throw missingGenre(genreId);
    }
  };

  const genreAt = (genreId: number | null | undefined): PublicGenre | null =>
    genreId === null || genreId === undefined
      ? null
      : (genres.get(genreId) ?? null);

  // After the last book in the series, as the real repository appends one.
  const append = (bookId: number, seriesId: number): void => {
    const last = Math.max(
      0,
      ...[...rows.values()]
        .filter((row) => row.seriesId === seriesId && row.id !== bookId)
        .map((row) => positions.get(row.id) ?? 0)
    );
    positions.set(bookId, last + 1);
  };

  const inSeriesOrder = (seriesId: number): PublicBook[] =>
    [...rows.values()]
      .filter((row) => row.seriesId === seriesId)
      .sort(
        (a, b) =>
          (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0) || a.id - b.id
      );

  return {
    async create(input) {
      assertSeries(input.seriesId);
      assertGenre(input.genreId);
      if (!accounts.has(input.userId)) {
        throw new NotFoundError('User', input.userId);
      }

      const now = new Date();
      const book: PublicBook = {
        id: nextId,
        authors: [],
        status: 'draft',
        seriesId: input.seriesId,
        series: null,
        title: input.title,
        description: input.description,
        tags: input.tags,
        genre: genreAt(input.genreId),
        coverUrl: null,
        createdAt: now,
        updatedAt: now,
      };
      nextId += 1;
      rows.set(book.id, book);
      credits.set(book.id, [input.userId]);
      if (book.seriesId !== null) append(book.id, book.seriesId);
      return withCredits(book);
    },

    async list(query, viewer): Promise<BookListResult> {
      viewers.push(viewer);
      const matching = (
        query.seriesId === undefined
          ? [...rows.values()]
          : inSeriesOrder(query.seriesId)
      ).filter(
        (row) =>
          (query.userId === undefined ||
            (credits.get(row.id) ?? []).includes(query.userId)) &&
          (query.ids === undefined || query.ids.includes(row.id)) &&
          (!query.tag || row.tags.includes(query.tag)) &&
          (query.genreId === undefined ||
            row.genre?.id === query.genreId ||
            row.genre?.parent?.id === query.genreId) &&
          (!query.q ||
            row.title.includes(query.q) ||
            row.description.includes(query.q))
      );
      // Past the end, the last non-empty page, as the real repository serves it.
      const current = Math.min(
        query.current,
        Math.max(1, Math.ceil(matching.length / query.pageSize))
      );
      const start = (current - 1) * query.pageSize;
      return {
        items: matching.slice(start, start + query.pageSize).map(withCredits),
        total: matching.length,
        current,
      };
    },

    async findById(id) {
      const book = rows.get(id);
      return book ? withCredits(book) : null;
    },

    async findDetailById(id, viewer): Promise<BookDetail | null> {
      viewers.push(viewer);
      const book = rows.get(id);
      if (!book) return null;

      return {
        ...withCredits(book),
        likeCount: likes.count,
        // Only a signed-in caller can have a like of their own to report.
        viewerLikeId: viewer === null ? null : likes.viewerLikeId,
        commentCount: tallies.commentCount,
        wordCount: tallies.wordCount,
        favoriteCount: favorites.count,
        viewerFavoriteId: viewer === null ? null : favorites.viewerFavoriteId,
        viewerReadingStatus: viewer === null ? null : library.viewerStatus,
        libraryCounts: library.counts,
      };
    },

    async update(id, input) {
      const current = rows.get(id);
      if (!current) return null;
      assertSeries(input.seriesId);
      assertGenre(input.genreId);

      const updated: PublicBook = {
        ...current,
        // `in` rather than `??`: an explicit null means "unlink", which a
        // nullish fallback would silently turn into "leave it alone".
        seriesId:
          'seriesId' in input ? (input.seriesId ?? null) : current.seriesId,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        tags: input.tags ?? current.tags,
        status: input.status ?? current.status,
        // `in` rather than `??`, as with seriesId: an explicit null means "no
        // Genre", which a nullish fallback would turn into "leave it alone".
        genre: 'genreId' in input ? genreAt(input.genreId) : current.genre,
        updatedAt: new Date(),
      };
      rows.set(id, updated);
      // Leaving a series clears the place; a move appends; staying keeps it.
      if (updated.seriesId === null) {
        positions.delete(id);
      } else if (updated.seriesId !== current.seriesId) {
        append(id, updated.seriesId);
      }
      return withCredits(updated);
    },

    async remove(id, actor) {
      actors.push(['remove', actor]);
      credits.delete(id);
      positions.delete(id);
      return rows.delete(id);
    },

    async addCoAuthor(bookId, userId, actor) {
      actors.push(['addCoAuthor', actor]);
      const book = rows.get(bookId);
      if (!book) return null;
      if (!accounts.has(userId)) throw new NotFoundError('User', userId);
      credits.set(bookId, [...(credits.get(bookId) ?? []), userId]);
      return withCredits(book);
    },

    async removeCoAuthor(bookId, userId, actor) {
      actors.push(['removeCoAuthor', actor]);
      const book = rows.get(bookId);
      if (!book) return null;
      credits.set(
        bookId,
        (credits.get(bookId) ?? []).filter((id) => id !== userId)
      );
      return withCredits(book);
    },

    async findCoAuthorIds(id) {
      const ids = credits.get(id);
      return ids ? [...ids] : null;
    },

    async listInSeries(seriesId) {
      if (!series.has(seriesId)) return null;
      return inSeriesOrder(seriesId).map((row) => {
        const { id, title, status, authors } = withCredits(row);
        return { id, title, status, authors };
      });
    },

    async reorderInSeries(seriesId, bookIds) {
      reorders.push({ seriesId, bookIds });
      if (!series.has(seriesId)) return false;
      bookIds.forEach((bookId, index) => {
        if (rows.get(bookId)?.seriesId === seriesId) {
          positions.set(bookId, index + 1);
        }
      });
      return true;
    },

    async setCover(bookId, data) {
      if (!rows.has(bookId)) return false;
      covers.set(bookId, { data, updatedAt: new Date() });
      return true;
    },

    async removeCover(bookId) {
      if (!rows.has(bookId)) return false;
      covers.delete(bookId);
      return true;
    },

    async getCoverData(bookId) {
      if (!rows.has(bookId)) return null;
      return covers.get(bookId) ?? null;
    },
  };
}
