import {
  col,
  ForeignKeyConstraintError,
  fn,
  literal,
  Op,
  where as sequelizeWhere,
} from 'sequelize';
import type { Order, Transaction, Utils, WhereOptions } from 'sequelize';
import { Book, toPublicBook } from '../models/Book.ts';
import { BookAuthor } from '../models/BookAuthor.ts';
import { BookCover } from '../models/BookCover.ts';
import { Chapter } from '../models/Chapter.ts';
import { Comment } from '../models/Comment.ts';
import { Favorite } from '../models/Favorite.ts';
import { LibraryEntry } from '../models/LibraryEntry.ts';
import {
  assertGenreExists,
  genreFamilyIds,
  genreOf,
  loadGenres,
} from './genreRepository.ts';
import {
  listedBookWhere,
  readableBookWhere,
  type Viewer,
} from './visibility.ts';
import { Like } from '../models/Like.ts';
import { Series } from '../models/Series.ts';
import { User } from '../models/User.ts';
import {
  addCoAuthor,
  asMissingUser,
  creditedIds,
  loadAuthors,
  removeCoAuthor,
  type CreditTable,
} from './coAuthors.ts';
import { NotFoundError, StateConflictError } from '../types/errors.ts';
import type {
  BookDetail,
  BookSeriesRef,
  BookSort,
  LibraryCounts,
  PublicBook,
  ReadingStatus,
  SeriesBookSummary,
} from 'shared';
import type {
  CreateBookInput,
  ListBooksQuery,
  UpdateBookInput,
} from '../types/book.ts';
import { containsPattern } from './likePattern.ts';
import { sequelizeOf } from './sequelizeOf.ts';
import { deleterOf, notify, type Actor } from './notificationRepository.ts';

export interface BookListResult {
  items: PublicBook[];
  total: number;
  // The page served, which is lower than the one asked for past the end.
  current: number;
}

export interface BookRepository {
  // userId is the book's first Co-author. It is not part of CreateBookInput:
  // it comes from the session, never the request body, so it is supplied as a
  // separate argument rather than a schema field a caller could set.
  create(input: CreateBookInput & { userId: number }): Promise<PublicBook>;
  list(query: ListBooksQuery, viewer: Viewer): Promise<BookListResult>;
  findById(id: number): Promise<PublicBook | null>;
  // Separate from findById rather than replacing it: the detail read costs a
  // series join, two like queries and two tallies, and the write paths that
  // only need to know a row exists should not pay for them.
  //
  // null, too, for a Draft book the viewer may not read: the caller reports it
  // exactly as a missing book, so a refusal does not reveal the draft exists.
  findDetailById(id: number, viewer: Viewer): Promise<BookDetail | null>;
  update(id: number, input: UpdateBookInput): Promise<PublicBook | null>;
  // The three writes that change who is credited on a book, or end it, take
  // the actor: each tells the other Co-authors in the same transaction
  // (repositories/notificationRepository.ts). Who may act is the controller's
  // business.
  remove(id: number, actor: Actor): Promise<boolean>;
  // null when the book is not there, as update/remove report it.
  addCoAuthor(
    bookId: number,
    userId: number,
    actor: Actor
  ): Promise<PublicBook | null>;
  // Covers both removing someone else and leaving — the actor naming the
  // account removed is what makes it a leave.
  removeCoAuthor(
    bookId: number,
    userId: number,
    actor: Actor
  ): Promise<PublicBook | null>;
  // The cheapest question the ownership check can ask: one indexed lookup, no
  // eager loads, no serialisation. null when the book is not there.
  findCoAuthorIds(id: number): Promise<number[] | null>;
  // The series editor's list: every book filed in the series, drafts included,
  // in Series order. Kept here rather than in seriesRepository because it reads
  // and writes books, as chapterRepository owns a book's chapter order. null
  // when the series is not there.
  listInSeries(seriesId: number): Promise<SeriesBookSummary[] | null>;
  // Rewrites the Series order to `bookIds`, which must name every book in the
  // series exactly once; anything else is a StateConflictError that changes
  // nothing. False when the series is not there.
  reorderInSeries(seriesId: number, bookIds: number[]): Promise<boolean>;
  // The Cover's bytes never ride along with any other read — these
  // three are the only place book_covers is touched. false/null mean "no
  // such Book", exactly as the other single-row methods report it —
  // removeCover included, so a caller can tell "no such Book" from "no Cover
  // to remove", which are both otherwise silent no-ops.
  setCover(bookId: number, data: Buffer): Promise<boolean>;
  removeCover(bookId: number): Promise<boolean>;
  getCoverData(
    bookId: number,
    viewer: Viewer
  ): Promise<{ data: Buffer; updatedAt: Date } | null>;
}

const credits: CreditTable = {
  type: 'book',
  find: async (bookIds, { withUser = false, transaction }) =>
    (
      await BookAuthor.findAll({
        where: { bookId: bookIds },
        include: withUser ? [{ model: User, as: 'user' }] : [],
        order: [['id', 'ASC']],
        transaction,
      })
    ).map(({ bookId, userId, user }) => ({ workId: bookId, userId, user })),
  create: (bookId, userId, transaction) =>
    BookAuthor.create({ bookId, userId }, { transaction }),
  destroy: (bookId, userId, transaction) =>
    BookAuthor.destroy({ where: { bookId, userId }, transaction }),
};

// Locks the series row, which settles whether the series exists. Lock order
// is the series row, then its book rows (.claude/rules/server/sequelize.md),
// so a caller that locks a book too takes this first.
async function lockSeries(
  seriesId: number,
  transaction: Transaction
): Promise<void> {
  const series = await Series.findByPk(seriesId, {
    attributes: ['id'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!series) throw new NotFoundError('Series', seriesId);
}

// The place a book filed into `seriesId` takes: after the last one. Under a
// lock on the series row, which a reorder takes too, so two books filed at
// once cannot share a place and one filed mid-reorder cannot land inside it.
// A caller that already holds the lock re-takes it harmlessly.
async function nextSeriesPosition(
  seriesId: number,
  transaction: Transaction
): Promise<number> {
  await lockSeries(seriesId, transaction);
  const last = await Book.max<number | null, Book>('seriesPosition', {
    where: { seriesId },
    transaction,
  });
  return (last ?? 0) + 1;
}

// Every Cover's URL for the books named, in one query — the same batching
// loadAuthors uses, and for the same reason: a page's LIMIT must stay over
// books, never over a joined table.
async function loadCoverUrls(
  bookIds: number[],
  transaction?: Transaction
): Promise<Map<number, string>> {
  if (bookIds.length === 0) return new Map();

  const covers = await BookCover.findAll({
    where: { bookId: bookIds },
    attributes: ['bookId', 'updatedAt'],
    transaction,
  });
  return new Map(
    covers.map((cover) => [
      cover.bookId,
      `/api/books/${cover.bookId}/cover?v=${cover.updatedAt.getTime()}`,
    ])
  );
}

// Each Book's Series and its place N in it, in one Series query and one Books
// query however many Books there are. N counts Published Books in Series order
// only, so a Draft book never shifts anyone's N; a Draft row itself gets null.
async function loadSeriesRefs(
  rows: Pick<Book, 'id' | 'seriesId' | 'status'>[],
  transaction?: Transaction
): Promise<Map<number, BookSeriesRef>> {
  const seriesIds = [
    ...new Set(
      rows.flatMap((row) => (row.seriesId === null ? [] : [row.seriesId]))
    ),
  ];
  const refs = new Map<number, BookSeriesRef>();
  if (seriesIds.length === 0) return refs;

  const [seriesRows, published] = await Promise.all([
    Series.findAll({
      where: { id: seriesIds },
      attributes: ['id', 'title'],
      transaction,
    }),
    Book.findAll({
      where: { seriesId: seriesIds, status: { [Op.ne]: 'draft' } },
      attributes: ['id', 'seriesId'],
      order: [
        ['seriesId', 'ASC'],
        ['seriesPosition', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    }),
  ]);
  const titles = new Map(seriesRows.map((row) => [row.id, row.title]));
  const placeOf = new Map<number, number>();
  const counted = new Map<number, number>();
  for (const row of published) {
    const place = (counted.get(row.seriesId as number) ?? 0) + 1;
    counted.set(row.seriesId as number, place);
    placeOf.set(row.id, place);
  }
  for (const row of rows) {
    const title = row.seriesId === null ? undefined : titles.get(row.seriesId);
    if (row.seriesId === null || title === undefined) continue;
    refs.set(row.id, {
      id: row.seriesId,
      title,
      position: row.status === 'draft' ? null : (placeOf.get(row.id) ?? null),
    });
  }
  return refs;
}

// A page of rows as PublicBooks, in the order given: credits, Covers and
// Genres in one query each, so a LIMIT keeps paging over books. Exported for
// favoriteRepository, whose rows embed the books they point at.
// `transaction` joins an open one.
export async function publicBooksOf(
  rows: Book[],
  transaction?: Transaction
): Promise<PublicBook[]> {
  const ids = rows.map((row) => row.id);
  const [authors, coverUrls, genres, seriesRefs] = await Promise.all([
    loadAuthors(credits, ids, transaction),
    loadCoverUrls(ids, transaction),
    loadGenres(
      rows.map((row) => row.genreId),
      transaction
    ),
    loadSeriesRefs(rows, transaction),
  ]);
  return rows.map((row) =>
    toPublicBook(
      row,
      authors.get(row.id) ?? [],
      coverUrls.get(row.id) ?? null,
      genreOf(row.genreId, genres),
      seriesRefs.get(row.id) ?? null
    )
  );
}

// Single-row form of publicBooksOf, so the single-row and batch reads cannot drift.
async function publicBook(
  book: Book,
  transaction?: Transaction
): Promise<PublicBook> {
  return (await publicBooksOf([book], transaction))[0] as PublicBook;
}

// The Publication time of a book's earliest (MIN) or latest (MAX) Published
// Chapter — its Release time or Last update (CONTEXT.md) — as a correlated
// subquery, NULL for a book with none. Chapters count once their Publication
// time has passed on this process's clock, as readableChapterScope judges
// them; the escaped Date is the only value spliced in.
function publicationEdge(edge: 'MIN' | 'MAX'): Utils.Literal {
  const now = sequelizeOf(Book).escape(new Date());
  return literal(
    `(SELECT ${edge}(\`publishedAt\`) FROM \`chapters\` WHERE \`chapters\`.\`bookId\` = \`Book\`.\`id\` AND \`publishedAt\` <= ${now})`
  );
}

// `sequelize.escape(Date)` truncates to whole seconds, which drops a filter's
// millisecond bound below a chapter's DATETIME(3) `publishedAt` and makes an
// inclusive bound miss its own exact instant. Formatted by hand instead, in
// the same UTC the connection assumes (no `timezone` override in db/sequelize.ts).
function escapeInstant(value: Date): string {
  return sequelizeOf(Book).escape(
    value.toISOString().replace('T', ' ').replace('Z', '')
  );
}

// What `?sort=` ranks a book row by (CONTEXT.md).
function rankOf(sort: BookSort): Utils.Literal {
  if (sort === 'popular') {
    return literal(
      '(SELECT COUNT(*) FROM `likes` WHERE `likes`.`bookId` = `Book`.`id` AND `likes`.`isLike` = true)'
    );
  }
  return publicationEdge(sort === 'new' ? 'MIN' : 'MAX');
}

// Ids looked up before the page query, one list per filter that matches
// through another table: a plain id list keeps the LIMIT paging over books,
// which an include would not. Undefined means the filter was not asked for;
// an empty list becomes `IN (NULL)`, which matches nothing, as it should.
interface IdLookups {
  creditedBookIds?: number[];
  authorBookIds?: number[];
  seriesIds?: number[];
  // bookId to the viewer's Favorite id, set by `?favoritedBy=me`.
  favorites?: Map<number, number>;
  // The viewer's Not interested Books, set by `?hideNotInterested=true`.
  notInterestedBookIds?: number[];
}

// The books any of whose Co-authors matches by login, first or last name.
// `login` carries a case-sensitive collation, so it is compared under the
// case-insensitive one, as userRepository's search does.
// ponytail: an id list grows with the matches; switch to an EXISTS subquery if
// a common name ever matches thousands of books.
async function booksByAuthor(author: string): Promise<number[]> {
  const pattern = containsPattern(author);
  const credits = await BookAuthor.findAll({
    attributes: ['bookId'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: [],
        required: true,
        where: {
          [Op.or]: [
            sequelizeWhere(
              literal('`user`.`login` COLLATE utf8mb4_0900_ai_ci'),
              { [Op.like]: pattern }
            ),
            { firstName: { [Op.like]: pattern } },
            { lastName: { [Op.like]: pattern } },
          ],
        },
      },
    ],
  });
  return credits.map((credit) => credit.bookId);
}

async function seriesTitled(title: string): Promise<number[]> {
  const series = await Series.findAll({
    where: { title: { [Op.like]: containsPattern(title) } },
    attributes: ['id'],
  });
  return series.map((entry) => entry.id);
}

async function favoritesOf(viewer: Viewer): Promise<Map<number, number>> {
  if (viewer === null) return new Map();
  const rows = await Favorite.findAll({
    where: { userId: viewer.id, bookId: { [Op.ne]: null } },
    attributes: ['id', 'bookId'],
  });
  return new Map(
    rows.flatMap((row) => (row.bookId === null ? [] : [[row.bookId, row.id]]))
  );
}

async function notInterestedOf(viewer: Viewer): Promise<number[]> {
  if (viewer === null) return [];
  const rows = await LibraryEntry.findAll({
    where: { userId: viewer.id, status: 'not_interested' },
    attributes: ['bookId'],
  });
  return rows.map((row) => row.bookId);
}

function buildWhere(
  query: ListBooksQuery,
  lookups: IdLookups,
  viewer: Viewer,
  genreIds: number[] | undefined
): WhereOptions {
  // No clause for a sort: a Book with nothing published has no Release time
  // or Last update, so `ORDER BY ... DESC` puts it last and `total` matches
  // what the pages list.
  const clauses: WhereOptions[] = [];

  // `?userId=`: a book matches through any of its Co-authors.
  if (lookups.creditedBookIds !== undefined) {
    clauses.push({ id: lookups.creditedBookIds });
  }
  if (lookups.authorBookIds !== undefined) {
    clauses.push({ id: lookups.authorBookIds });
  }
  if (lookups.seriesIds !== undefined) {
    clauses.push({ seriesId: lookups.seriesIds });
  }
  if (lookups.favorites !== undefined) {
    clauses.push({ id: [...lookups.favorites.keys()] });
  }
  // An empty list excludes nothing, so it adds no clause.
  if (lookups.notInterestedBookIds?.length) {
    clauses.push({ id: { [Op.notIn]: lookups.notInterestedBookIds } });
  }

  if (query.status !== undefined) {
    clauses.push({ status: query.status });
  }

  // Both bounds inclusive. A book with nothing published has a NULL edge,
  // which no comparison matches, so any bound set leaves it out.
  for (const [edge, from, to] of [
    ['MIN', query.releasedFrom, query.releasedTo],
    ['MAX', query.updatedFrom, query.updatedTo],
  ] as const) {
    if (from !== undefined) {
      clauses.push(
        literal(`${publicationEdge(edge).val} >= ${escapeInstant(from)}`)
      );
    }
    if (to !== undefined) {
      clauses.push(
        literal(`${publicationEdge(edge).val} <= ${escapeInstant(to)}`)
      );
    }
  }

  if (query.ids !== undefined) {
    clauses.push({ id: query.ids });
  }

  // Mirrors the non-Owner branch of `listedBookWhere`, which the private
  // Profile still needs for the Owner's Drafts. `ids` is a public lookup, never
  // a Draft, even the viewer's own.
  const listed =
    query.published === undefined && query.ids === undefined
      ? listedBookWhere(viewer, query.userId)
      : { status: { [Op.ne]: 'draft' } };
  if (listed !== null) clauses.push(listed);

  if (query.seriesId !== undefined) {
    clauses.push({ seriesId: query.seriesId });
  }

  // genreIds is the Genre `?genreId=` names plus its Subgenres, looked up
  // beforehand. Combined with the other filters by AND. An empty list (an id
  // that names no Genre) becomes `IN (NULL)`, matching nothing, as an unknown
  // `?tag=` does.
  if (genreIds !== undefined) {
    clauses.push({ genreId: genreIds });
  }

  if (query.tag) {
    // MySQL cannot index into a plain JSON array with `=`, so membership goes
    // through JSON_CONTAINS. The tag is passed as an argument to fn(), which
    // Sequelize escapes as a literal — it is never concatenated into the SQL.
    clauses.push(
      sequelizeWhere(
        fn('JSON_CONTAINS', col('tags'), JSON.stringify(query.tag)),
        Op.eq,
        1
      )
    );
  }

  if (query.q) {
    // Searches the title as well as the description, so `?q=` finds a book by
    // its name. Both sides are a leading-wildcard LIKE and therefore a full
    // scan — unavoidable for substring search, and the cost the description
    // side already paid. The scan runs once per search, twice only for a page
    // past the end.
    const pattern = containsPattern(query.q);
    clauses.push({
      [Op.or]: [
        { title: { [Op.like]: pattern } },
        { description: { [Op.like]: pattern } },
      ],
    });
  }

  return clauses.length > 0 ? { [Op.and]: clauses } : {};
}

// Not interested is never read, so it can never reach a reader.
function toLibraryCounts(
  rows: { status?: unknown; count: number }[]
): LibraryCounts {
  const of = (status: ReadingStatus) =>
    rows.find((row) => row.status === status)?.count ?? 0;
  const [reading, planToRead, read] = [
    of('reading'),
    of('plan_to_read'),
    of('read'),
  ];
  return {
    reading,
    planToRead,
    read,
    inLibraries: reading + planToRead + read,
  };
}

export function createSequelizeBookRepository(): BookRepository {
  return {
    async create(input) {
      try {
        // One transaction, so a book never exists without its first credit.
        return await sequelizeOf(Book).transaction(async (transaction) => {
          const { userId, ...attributes } = input;
          await assertGenreExists(attributes.genreId, transaction);
          const seriesPosition =
            attributes.seriesId === null
              ? null
              : await nextSeriesPosition(attributes.seriesId, transaction);
          const book = await Book.create(
            { ...attributes, seriesPosition },
            { transaction }
          );
          await credits.create(book.id, userId, transaction);
          return publicBook(book, transaction);
        });
      } catch (error) {
        asMissingUser(error, input.userId);
      }
    },

    async list(query, viewer) {
      const lookups: IdLookups = {
        creditedBookIds:
          query.userId === undefined
            ? undefined
            : (
                await BookAuthor.findAll({
                  where: { userId: query.userId },
                  attributes: ['bookId'],
                })
              ).map((credit) => credit.bookId),
        authorBookIds:
          query.author === undefined
            ? undefined
            : await booksByAuthor(query.author),
        seriesIds:
          query.seriesTitle === undefined
            ? undefined
            : await seriesTitled(query.seriesTitle),
        favorites:
          query.favoritedBy === undefined
            ? undefined
            : await favoritesOf(viewer),
        notInterestedBookIds:
          query.hideNotInterested === undefined
            ? undefined
            : await notInterestedOf(viewer),
      };

      const rank = query.sort === undefined ? undefined : rankOf(query.sort);
      const genreIds =
        query.genreId === undefined
          ? undefined
          : await genreFamilyIds(query.genreId);
      const where = buildWhere(query, lookups, viewer, genreIds);
      // A ranked list goes best first, ties to the newer book; otherwise a
      // series' books come in Series order and every other list by id.
      const order: Order =
        rank !== undefined
          ? [
              [rank, 'DESC'],
              ['id', 'DESC'],
            ]
          : query.seriesId === undefined
            ? [['id', 'ASC']]
            : [
                ['seriesPosition', 'ASC'],
                ['id', 'ASC'],
              ];
      // A page in range costs one query: the page query carries the filtered
      // total. A page past the end recounts and refetches; the rule is in
      // `.claude/rules/server/api.md`.
      let rows = await Book.findAll({
        where,
        attributes: { include: [[literal('COUNT(*) OVER()'), 'total']] },
        limit: query.pageSize,
        offset: (query.current - 1) * query.pageSize,
        order,
      });
      // The window count is a MySQL BIGINT, which can arrive as a string.
      let total = Number(rows[0]?.get('total') ?? 0);
      let current = query.current;
      if (rows.length === 0 && query.current > 1) {
        total = await Book.count({ where });
        current = Math.min(
          query.current,
          Math.max(1, Math.ceil(total / query.pageSize))
        );
        rows = await Book.findAll({
          where,
          limit: query.pageSize,
          offset: (current - 1) * query.pageSize,
          order,
        });
      }

      const items = await publicBooksOf(rows);
      const { favorites } = lookups;
      return {
        items:
          favorites === undefined
            ? items
            : items.map((item) => ({
                ...item,
                favoriteId: favorites.get(item.id),
              })),
        total,
        current,
      };
    },

    async findById(id) {
      const book = await Book.findByPk(id);
      return book ? publicBook(book) : null;
    },

    async findDetailById(id, viewer) {
      const viewerId = viewer?.id ?? null;
      const book = await Book.findOne({
        where: { [Op.and]: [{ id }, await readableBookWhere(viewer)] },
      });
      if (!book) return null;

      // Follow-up queries rather than correlated subqueries in the SELECT
      // above, which keeps the include readable; none depends on another, so
      // they run at once. The word count is judged Published on this
      // process's clock, as readableChapterScope judges it, but the viewer
      // never widens it: a Co-author's Draft and Scheduled chapters do not
      // count. SUM over no row is NULL, hence ?? 0.
      // A Draft book's Favorites are kept but not counted (CONTEXT.md,
      // Favorite), whoever reads the detail. The viewer's own row is still
      // named, so the button matches what exists.
      const [
        likeCount,
        viewerLike,
        commentCount,
        wordCount,
        favoriteCount,
        viewerFavorite,
        statusRows,
        viewerEntry,
      ] = await Promise.all([
        Like.count({ where: { bookId: id, isLike: true } }),
        viewerId === null
          ? null
          : Like.findOne({
              where: { bookId: id, userId: viewerId },
              attributes: ['id'],
            }),
        Comment.count({ where: { bookId: id, tombstone: null } }),
        Chapter.aggregate<number | null, Chapter>('wordCount', 'sum', {
          where: { bookId: id, publishedAt: { [Op.lte]: new Date() } },
        }),
        book.status === 'draft' ? 0 : Favorite.count({ where: { bookId: id } }),
        viewerId === null
          ? null
          : Favorite.findOne({
              where: { bookId: id, userId: viewerId },
              attributes: ['id'],
            }),
        // Like a Draft's Favorites, its Library entries are kept but not
        // counted; the viewer's own entry is still named.
        book.status === 'draft'
          ? []
          : LibraryEntry.count({ where: { bookId: id }, group: ['status'] }),
        viewerId === null
          ? null
          : LibraryEntry.findOne({
              where: { bookId: id, userId: viewerId },
              attributes: ['status'],
            }),
      ]);

      return {
        ...(await publicBook(book)),
        likeCount,
        viewerLikeId: viewerLike?.id ?? null,
        commentCount,
        wordCount: wordCount ?? 0,
        favoriteCount,
        viewerFavoriteId: viewerFavorite?.id ?? null,
        viewerReadingStatus: viewerEntry?.status ?? null,
        libraryCounts: toLibraryCounts(statusRows),
      };
    },

    // No foreign-key mapping, unlike create: seriesId and genreId are the only
    // references an update can write, and asMissingUser (coAuthors.ts) explains why neither
    // can be rejected.
    //
    // Locks the series, then the book (sequelize.md Lock order). The series is
    // peeked unlocked first: the book row cannot be locked first.
    async update(id, input) {
      const peeked = await Book.findByPk(id, {
        attributes: ['id', 'seriesId'],
      });
      if (!peeked) return null;

      return sequelizeOf(Book).transaction(async (transaction) => {
        const namedSeriesId =
          typeof input.seriesId === 'number' ? input.seriesId : null;
        // A move from series A to B locks only B, which still follows the order.
        const lockedSeriesId = namedSeriesId ?? peeked.seriesId;
        if (lockedSeriesId !== null)
          await lockSeries(lockedSeriesId, transaction);

        const book = await Book.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) return null;

        if (namedSeriesId === null && book.seriesId !== peeked.seriesId) {
          throw new StateConflictError(
            'The book was moved to another series; try again'
          );
        }

        await assertGenreExists(input.genreId, transaction);

        const wasDraft = book.status === 'draft';

        // `update` writes only the keys present, so an omitted seriesId
        // leaves the link — and the book's place — alone, while an explicit
        // null clears both. Saving a book into the series it is already in
        // keeps its place; only a move appends it.
        const changes: UpdateBookInput & { seriesPosition?: number | null } = {
          ...input,
        };
        if (input.seriesId === null) {
          changes.seriesPosition = null;
        } else if (
          input.seriesId !== undefined &&
          input.seriesId !== book.seriesId
        ) {
          changes.seriesPosition = await nextSeriesPosition(
            input.seriesId,
            transaction
          );
        }

        await book.update(changes, { transaction });

        // A Book turning Published with Chapters already past their
        // Publication time: one New book to Series Favorites; its Chapters
        // are marked announced without Notifications (CONTEXT.md) — so a
        // chapter that was already out when the book was still a draft never
        // gets its own New chapter mail once the pass finds it. `silent`
        // keeps chapters.updatedAt (the edit version) unchanged. The pass's
        // own draft-backlog step still raises the book's New book.
        if (wasDraft && book.status !== 'draft') {
          const now = new Date();
          await Chapter.update(
            { announcedAt: now },
            {
              where: {
                bookId: book.id,
                announcedAt: null,
                publishedAt: { [Op.lte]: now },
              },
              transaction,
              silent: true,
            }
          );
        }

        return publicBook(book, transaction);
      });
    },

    // Under a lock on the book row, so the Co-authors told are exactly the ones
    // credited when it went.
    async remove(id, actor) {
      return sequelizeOf(Book).transaction(async (transaction) => {
        const book = await Book.findByPk(id, {
          attributes: ['id', 'title'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) return false;

        const coAuthorIds = await creditedIds(credits, id, transaction);
        await notify(
          [
            {
              recipientIds: coAuthorIds,
              kind: 'work_deleted',
              work: { type: 'book', id: null, title: book.title },
              ...(await deleterOf(actor, coAuthorIds, transaction)),
            },
          ],
          actor.id,
          transaction
        );

        await Book.destroy({ where: { id }, transaction });
        return true;
      });
    },

    async addCoAuthor(bookId, userId, actor) {
      return sequelizeOf(Book).transaction(async (transaction) => {
        const book = await Book.findByPk(bookId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) return null;

        await addCoAuthor(credits, book, userId, actor, transaction);
        return publicBook(book, transaction);
      });
    },

    async removeCoAuthor(bookId, userId, actor) {
      return sequelizeOf(Book).transaction(async (transaction) => {
        const book = await Book.findByPk(bookId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!book) return null;

        await removeCoAuthor(credits, book, userId, actor, transaction);
        return publicBook(book, transaction);
      });
    },

    async findCoAuthorIds(id) {
      const book = await Book.findByPk(id, { attributes: ['id'] });
      return book ? creditedIds(credits, id) : null;
    },

    async listInSeries(seriesId) {
      const series = await Series.findByPk(seriesId, { attributes: ['id'] });
      if (!series) return null;

      const books = await Book.findAll({
        where: { seriesId },
        attributes: ['id', 'title', 'status'],
        order: [
          ['seriesPosition', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      const authors = await loadAuthors(
        credits,
        books.map((book) => book.id)
      );
      return books.map((book) => ({
        id: book.id,
        title: book.title,
        status: book.status,
        authors: authors.get(book.id) ?? [],
      }));
    },

    async reorderInSeries(seriesId, bookIds) {
      return sequelizeOf(Book).transaction(async (transaction) => {
        const series = await Series.findByPk(seriesId, {
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!series) return false;

        const current = await Book.findAll({
          where: { seriesId },
          attributes: ['id'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const currentIds = new Set(current.map((book) => book.id));
        const sameSet =
          new Set(bookIds).size === bookIds.length &&
          bookIds.length === currentIds.size &&
          bookIds.every((bookId) => currentIds.has(bookId));
        if (!sameSet) {
          throw new StateConflictError(
            'The books of this series changed since you loaded them'
          );
        }

        // One statement, and silent, for the reasons chapterRepository.reorder
        // gives: FIELD(id, …) is each id's 1-based place, and a reorder is not
        // an edit to any book.
        await Book.update(
          { seriesPosition: fn('FIELD', col('id'), ...bookIds) },
          { where: { seriesId }, transaction, silent: true }
        );
        return true;
      });
    },

    async setCover(bookId, data) {
      // The cover row's foreign key is the existence check, so a book deleted
      // mid-upload reads as not found (as commentRepository maps it).
      try {
        await BookCover.upsert({ bookId, data });
        return true;
      } catch (error) {
        if (error instanceof ForeignKeyConstraintError) return false;
        throw error;
      }
    },

    async removeCover(bookId) {
      const book = await Book.findByPk(bookId, { attributes: ['id'] });
      if (!book) return false;
      await BookCover.destroy({ where: { bookId } });
      return true;
    },

    async getCoverData(bookId, viewer) {
      const book = await Book.findOne({
        where: { [Op.and]: [{ id: bookId }, await readableBookWhere(viewer)] },
        attributes: ['id'],
      });
      if (!book) return null;

      const cover = await BookCover.findByPk(bookId, {
        attributes: ['data', 'updatedAt'],
      });
      return cover ? { data: cover.data, updatedAt: cover.updatedAt } : null;
    },
  };
}
