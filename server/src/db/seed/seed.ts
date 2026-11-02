// Demo data: twelve accounts, three authors' worth of published work, and the
// comment threads and likes that make the reader-facing pages look lived-in.
//
// It writes through the models, not the HTTP API: register can only mint a
// `user`, content writes would need a session cookie per persona, and several
// hundred chapter POSTs against a running server is slow. The payloads are
// still parsed by the routes' zod schemas, so nothing lands that the API would
// refuse; only the identity fields those schemas withhold (owner, role) are
// attached afterwards.
//
// Every count is drawn from a PRNG with a fixed seed, so two runs give the
// same shape. Only the dates move, anchored to the moment of the run (see
// PUBLICATION_WINDOW_DAYS): a demo whose newest chapter is a year old looks
// abandoned.
//
// Destructive: with --force it deletes every row in the content tables first.
// Without it, the script reports what it found and exits without writing.

import type { ModelStatic, Model, Transaction } from 'sequelize';
import { logger, messageOf } from '../../logger.ts';
import { initModels } from '../../models/index.ts';
import { Book } from '../../models/Book.ts';
import { BookAuthor } from '../../models/BookAuthor.ts';
import { Chapter } from '../../models/Chapter.ts';
import { Comment } from '../../models/Comment.ts';
import { Report } from '../../models/Report.ts';
import { Favorite } from '../../models/Favorite.ts';
import { destroyAllGenres, Genre } from '../../models/Genre.ts';
import { Illustration } from '../../models/Illustration.ts';
import { LibraryEntry } from '../../models/LibraryEntry.ts';
import { Like } from '../../models/Like.ts';
import { Notification } from '../../models/Notification.ts';
import { ReadingList } from '../../models/ReadingList.ts';
import { ReadingListItem } from '../../models/ReadingListItem.ts';
import { Series } from '../../models/Series.ts';
import { SeriesAuthor } from '../../models/SeriesAuthor.ts';
import { User } from '../../models/User.ts';
import { createBookSchema } from '../../types/book.ts';
import { createChapterSchema } from '../../types/chapter.ts';
import { createCommentSchema } from '../../types/comment.ts';
import { createFavoriteSchema } from '../../types/favorite.ts';
import { createLikeSchema } from '../../types/like.ts';
import { createReadingListSchema } from '../../types/readingList.ts';
import { createReportSchema } from '../../types/report.ts';
import { createSeriesSchema } from '../../types/series.ts';
import { createUserSchema } from '../../types/user.ts';
import { loadConfig } from '../config.ts';
import { ensureDatabase } from '../ensureDatabase.ts';
import { GENRE_TREE, parentGenreOf } from './content.ts';
import {
  DAY_MS,
  buildPlan,
  type Plan,
  type PlannedAuthor,
  type PlannedBook,
  type PlannedComment,
  type PlannedSeries,
} from './plan.ts';
import { RNG_SEED, createRng, itemAt } from './rng.ts';
import { assertSafeTarget } from './seedGuards.ts';
import { createSequelize } from '../sequelize.ts';

// One password for all twelve accounts: demo data, not a credential. It is
// printed at the end of a run.
const DEMO_PASSWORD = 'Password123!';

// Batched for MySQL's max_allowed_packet: 200 chapter rows of ~2 KB is ~400 KB,
// inside even a conservative 4 MB limit.
const INSERT_BATCH = 200;

// Deleted from the dependent end upwards rather than left to the cascades:
// deleting `users` alone would take everything today, but that is a property
// of the schema's ON DELETE clauses, and if one changes a seed relying on it
// would leave rows behind silently. `genres` follows `books` and `series` for
// the same reason. `permissions` is absent on purpose: syncPermissions()
// derives it from code, so it is not demo content.
const CONTENT_MODELS: readonly ModelStatic<Model>[] = [
  Notification,
  ReadingListItem,
  ReadingList,
  Favorite,
  LibraryEntry,
  Like,
  Report,
  Comment,
  Illustration,
  Chapter,
  BookAuthor,
  Book,
  SeriesAuthor,
  Series,
  Genre,
  User,
];

async function insertInBatches<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await insert(rows.slice(i, i + INSERT_BATCH));
  }
}

// Returns the ids in the same order as plan.accounts, which is how every
// accountIndex in the plan is resolved.
async function writeAccounts(
  plan: Plan,
  transaction: Transaction
): Promise<number[]> {
  const ids: number[] = [];

  for (const { spec, createdAt, lastSeenAt } of plan.accounts) {
    // createUserSchema carries no `role` on purpose: the role travels
    // separately so a PATCH body can never smuggle one in. The seed follows
    // that split rather than working around it. lastSeenAt is attached the
    // same way, after parsing: no request body may set it.
    const fields = createUserSchema.parse({
      login: spec.login,
      email: `${spec.login}@example.com`,
      password: DEMO_PASSWORD,
      firstName: spec.firstName,
      lastName: spec.lastName,
      status: spec.status ?? 'active',
      about: spec.about,
      showLastSeen: spec.showLastSeen,
    });

    // create(), not bulkCreate: bulkCreate defaults to individualHooks: false,
    // which would skip User.beforeSave and store the password in clear text.
    // `silent` is what stops save() from overwriting the backdated updatedAt.
    const user = await User.create(
      {
        ...fields,
        role: spec.role,
        lastSeenAt,
        createdAt,
        updatedAt: createdAt,
      },
      { transaction, silent: true }
    );
    ids.push(user.id);
  }

  return ids;
}

// The Genre list, written before any content so writeContent can file each work
// under one. Returned as a name → id map, which is how a content bank's
// genreName becomes a genreId.
//
// create() in a loop rather than bulkCreate: a dozen rows are nothing, and the
// ids have to come back — a loop gets them without depending on MySQL
// back-filling them from the insert's first id (see writeThreads, where that
// assumption does live and is checked). A parent is written before its
// Subgenres, which need its id.
async function writeGenres(
  transaction: Transaction
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();

  for (const { name, subgenres } of GENRE_TREE) {
    const parent = await Genre.create({ name }, { transaction });
    ids.set(name, parent.id);
    for (const subgenre of subgenres) {
      const row = await Genre.create(
        { name: subgenre, parentId: parent.id },
        { transaction }
      );
      ids.set(subgenre, row.id);
    }
  }

  return ids;
}

async function writeContent(
  plan: Plan,
  accountIds: readonly number[],
  genreIds: ReadonlyMap<string, number>,
  transaction: Transaction
): Promise<{
  bookIds: Map<PlannedBook, number>;
  seriesIds: Map<PlannedSeries, number>;
  chapters: number;
  series: number;
}> {
  const idByLogin = new Map(
    plan.accounts.map((account, index) => [
      account.spec.login,
      itemAt(accountIds, index, 'account id'),
    ])
  );

  const idOf = (login: string): number => {
    const id = idByLogin.get(login);
    if (id === undefined) {
      throw new Error(`No account was created for ${login}`);
    }
    return id;
  };

  const genreIdOf = (name: string): number => {
    const id = genreIds.get(name);
    if (id === undefined) {
      throw new Error(`No genre row was created for ${name}`);
    }
    return id;
  };

  const bookIds = new Map<PlannedBook, number>();
  const seriesIdsByPlan = new Map<PlannedSeries, number>();
  const creditRows: { bookId: number; userId: number; createdAt: Date }[] = [];
  const seriesCreditRows: {
    seriesId: number;
    userId: number;
    createdAt: Date;
  }[] = [];
  const chapterRows: {
    bookId: number;
    title: string;
    text: string;
    publishedAt: Date | null;
    announcedAt: Date | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  let seriesCount = 0;

  // Everything already out when the seed runs counts as announced, or the
  // first announcement pass would tell every Favorite holder about the whole
  // catalogue (ADR-0013). Scheduled chapters stay unannounced: the pass
  // announces them when their time comes, as it would for a real author's.
  const seededAt = new Date();
  const isOut = (moment: Date | null): moment is Date =>
    moment !== null && moment <= seededAt;

  for (const author of plan.authors) {
    // Every Book and Series drawn from this author's bank is filed under the
    // bank's Subgenre (the odd-numbered works: first, third, …) or its parent
    // Genre (the even-numbered ones), so both levels hold work. Counted from position, not drawn, to leave the seed's RNG
    // sequence alone. A co-authored work keeps the Genre of the author it was
    // planned under — the only author whose bank it came from.
    const subgenre = author.spec.bank.genreName;
    const genreIdAt = (position: number): number =>
      genreIdOf(position % 2 === 0 ? subgenre : parentGenreOf(subgenre));
    const seriesIds: number[] = [];
    for (const [seriesPosition, entry] of author.series.entries()) {
      const genreId = genreIdAt(seriesPosition);
      const fields = createSeriesSchema.parse({ ...entry, genreId });
      const row = await Series.create(
        { ...fields, createdAt: entry.createdAt, updatedAt: entry.createdAt },
        { transaction, silent: true }
      );
      seriesIds.push(row.id);
      seriesIdsByPlan.set(entry, row.id);
      seriesCount += 1;
      for (const login of entry.coAuthorLogins) {
        seriesCreditRows.push({
          seriesId: row.id,
          userId: idOf(login),
          createdAt: entry.createdAt,
        });
      }
    }

    // Each series' books take their places in the order the plan lists them,
    // as bookRepository would append them one by one.
    const filedSoFar = new Map<number, number>();
    for (const [bookPosition, book] of author.books.entries()) {
      const fields = createBookSchema.parse({
        ...book,
        genreId: genreIdAt(bookPosition),
        seriesId:
          book.seriesIndex === null
            ? null
            : itemAt(seriesIds, book.seriesIndex, 'series id'),
      });
      const row = await Book.create(
        {
          ...fields,
          // Attached after the parse, like the Co-authors: createBookSchema
          // has no status, because every book the API creates is a draft.
          status: book.status,
          announcedAt:
            book.status !== 'draft' &&
            book.chapters.some((chapter) => isOut(chapter.publishedAt))
              ? seededAt
              : null,
          seriesPosition: seriesPositionOf(book.seriesIndex, filedSoFar),
          createdAt: book.createdAt,
          updatedAt: book.createdAt,
        },
        { transaction, silent: true }
      );
      bookIds.set(book, row.id);
      // In credit order: bulkCreate inserts the rows in one statement, in
      // input order, and the byline is ordered by the credits' ids.
      for (const login of book.coAuthorLogins) {
        creditRows.push({
          bookId: row.id,
          userId: idOf(login),
          createdAt: book.createdAt,
        });
      }

      for (const [index, chapter] of book.chapters.entries()) {
        const parsed = createChapterSchema.parse({
          bookId: row.id,
          title: chapter.title,
          text: chapter.text,
        });
        chapterRows.push({
          bookId: parsed.bookId,
          title: parsed.title,
          text: parsed.text,
          // Attached after the parse, like a book's status: the schema's
          // publishedAt is 'now' or a future moment, and the seed backdates.
          publishedAt: chapter.publishedAt,
          // A Draft book's chapters stay unannounced too, so publishing the
          // book later announces it as a New book, as it would via the API.
          announcedAt:
            book.status !== 'draft' && isOut(chapter.publishedAt)
              ? seededAt
              : null,
          // The Reading order is the order the plan wrote them in, 1-based
          // like the positions chapterRepository appends.
          position: index + 1,
          createdAt: chapter.createdAt,
          updatedAt: chapter.createdAt,
        });
      }
    }
  }

  await insertInBatches(seriesCreditRows, (batch) =>
    SeriesAuthor.bulkCreate(batch, { transaction })
  );
  await insertInBatches(creditRows, (batch) =>
    BookAuthor.bulkCreate(batch, { transaction })
  );
  await insertInBatches(chapterRows, (batch) =>
    Chapter.bulkCreate(batch, { transaction })
  );

  return {
    bookIds,
    seriesIds: seriesIdsByPlan,
    chapters: chapterRows.length,
    series: seriesCount,
  };
}

// The next place in the author's series at `seriesIndex`, or null for a
// standalone book.
function seriesPositionOf(
  seriesIndex: number | null,
  filedSoFar: Map<number, number>
): number | null {
  if (seriesIndex === null) return null;
  const position = (filedSoFar.get(seriesIndex) ?? 0) + 1;
  filedSoFar.set(seriesIndex, position);
  return position;
}

function workIdOf<T extends { title: string }>(
  ids: Map<T, number>,
  work: T
): number {
  const id = ids.get(work);
  if (id === undefined) {
    throw new Error(`No row was created for "${work.title}"`);
  }
  return id;
}

// Two unread notifications for each author, drawn from the credits the plan
// already holds so that none contradicts a byline. Every Co-author credited on
// a shared work beyond its first is told the first added them; and each author
// is told the next author in AUTHORS left one of their books that nobody else
// shares now — which reads true, since a Co-author who left is credited
// nowhere on it. The actor's name is written as a notification would have
// written it at the time.
async function writeNotifications(
  plan: Plan,
  accountIds: readonly number[],
  bookIds: Map<PlannedBook, number>,
  seriesIds: Map<PlannedSeries, number>,
  transaction: Transaction
): Promise<number> {
  const idOf = (login: string): number => {
    const index = plan.accounts.findIndex(
      (account) => account.spec.login === login
    );
    if (index === -1) throw new Error(`No account was planned for ${login}`);
    return itemAt(accountIds, index, 'account id');
  };
  const nameOf = (author: PlannedAuthor): string =>
    `${author.spec.firstName} ${author.spec.lastName}`;
  const now = Date.now();

  const rows: {
    userId: number;
    kind: 'co_author_added' | 'co_author_left';
    workType: 'book' | 'series';
    bookId: number | null;
    seriesId: number | null;
    workTitle: string;
    actorKind: 'co_author';
    actorName: string;
    createdAt: Date;
  }[] = [];

  for (const [index, author] of plan.authors.entries()) {
    for (const entry of author.series) {
      for (const login of entry.coAuthorLogins.slice(1)) {
        rows.push({
          userId: idOf(login),
          kind: 'co_author_added',
          workType: 'series',
          bookId: null,
          seriesId: workIdOf(seriesIds, entry),
          workTitle: entry.title,
          actorKind: 'co_author',
          actorName: nameOf(author),
          createdAt: new Date(now - 3 * DAY_MS),
        });
      }
    }
    for (const book of author.books) {
      for (const login of book.coAuthorLogins.slice(1)) {
        rows.push({
          userId: idOf(login),
          kind: 'co_author_added',
          workType: 'book',
          bookId: workIdOf(bookIds, book),
          seriesId: null,
          workTitle: book.title,
          actorKind: 'co_author',
          actorName: nameOf(author),
          createdAt: new Date(now - 2 * DAY_MS),
        });
      }
    }

    const leaver = itemAt(
      plan.authors,
      (index + 1) % plan.authors.length,
      'author'
    );
    const left = author.books.find(
      (book) => book.coAuthorLogins.length === 1 && book.status !== 'draft'
    );
    if (left) {
      rows.push({
        userId: idOf(author.spec.login),
        kind: 'co_author_left',
        workType: 'book',
        bookId: workIdOf(bookIds, left),
        seriesId: null,
        workTitle: left.title,
        actorKind: 'co_author',
        actorName: nameOf(leaver),
        createdAt: new Date(now - DAY_MS),
      });
    }
  }

  await Notification.bulkCreate(rows, { transaction });
  return rows.length;
}

async function writeThreads(
  plan: Plan,
  accountIds: readonly number[],
  bookIds: Map<PlannedBook, number>,
  transaction: Transaction
): Promise<{
  comments: number;
  likes: number;
  commentIds: Map<PlannedComment, number>;
}> {
  const bookIdOf = (book: PlannedBook): number => {
    const id = bookIds.get(book);
    if (id === undefined) {
      throw new Error(`No row was created for the book "${book.title}"`);
    }
    return id;
  };

  const commentIds = new Map<PlannedComment, number>();
  const maxDepth = plan.comments.reduce(
    (deepest, comment) => Math.max(deepest, comment.depth),
    0
  );

  // Level by level, because a reply needs its parent's id. bulkCreate on MySQL
  // back-fills the ids from the insert's first id plus the row count, in input
  // order; the check below is what would notice if that ever stopped holding.
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const level = plan.comments.filter((comment) => comment.depth === depth);
    if (level.length === 0) {
      continue;
    }

    const rows = level.map((comment) => {
      const parsed = createCommentSchema.parse({
        bookId: bookIdOf(comment.book),
        parentId:
          comment.parent === null ? null : commentIds.get(comment.parent),
        text: comment.text,
      });
      return {
        ...parsed,
        userId: itemAt(accountIds, comment.accountIndex, 'account id'),
        tombstone: plan.tombstones.get(comment) ?? null,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
      };
    });

    // Not batched: the ids have to come back, and a batch boundary is one more
    // place for the ordering assumption above to go wrong.
    const created = await Comment.bulkCreate(rows, { transaction });
    created.forEach((row, index) => {
      if (typeof row.id !== 'number') {
        throw new Error(
          'bulkCreate returned no comment id; replies cannot be linked'
        );
      }
      commentIds.set(itemAt(level, index, 'comment'), row.id);
    });
  }

  const likeRows = plan.likes.map((like) => {
    const parsed = createLikeSchema.parse({
      bookId: like.book === null ? null : bookIdOf(like.book),
      commentId: like.comment === null ? null : commentIds.get(like.comment),
      isLike: like.isLike,
    });
    return {
      ...parsed,
      userId: itemAt(accountIds, like.accountIndex, 'account id'),
      createdAt: like.createdAt,
    };
  });

  await insertInBatches(likeRows, (batch) =>
    Like.bulkCreate(batch, { transaction })
  );

  return { comments: plan.comments.length, likes: likeRows.length, commentIds };
}

async function writeReports(
  plan: Plan,
  accountIds: readonly number[],
  commentIds: ReadonlyMap<PlannedComment, number>,
  transaction: Transaction
): Promise<number> {
  const accountIdAt = (index: number | null): number | null =>
    index === null ? null : itemAt(accountIds, index, 'account id');

  const rows = plan.reports.map((report) => {
    const commentId = commentIds.get(report.comment);
    if (commentId === undefined) {
      throw new Error('No row was created for a reported comment');
    }
    const settledOrFiled = report.settledAt ?? report.createdAt;
    return {
      ...createReportSchema.parse({
        reason: report.reason,
        explanation: report.explanation ?? undefined,
      }),
      commentId,
      reporterId: accountIdAt(report.reporterIndex),
      isSystem: report.reporterIndex === null,
      reportedAccountId: accountIdAt(report.comment.accountIndex),
      status: report.status,
      moderatorId: accountIdAt(report.moderatorIndex),
      settledText: report.settledText,
      takenAt: report.takenAt,
      settledAt: report.settledAt,
      createdAt: report.createdAt,
      updatedAt: settledOrFiled,
    };
  });

  // A few dozen rows: far below INSERT_BATCH, so one insert.
  await Report.bulkCreate(rows, { transaction });
  return rows.length;
}

async function writeFavorites(
  plan: Plan,
  accountIds: readonly number[],
  bookIds: Map<PlannedBook, number>,
  seriesIds: Map<PlannedSeries, number>,
  transaction: Transaction
): Promise<number> {
  const rows = plan.favorites.map((favorite) => ({
    ...createFavoriteSchema.parse({
      bookId: favorite.book === null ? null : workIdOf(bookIds, favorite.book),
      seriesId:
        favorite.series === null ? null : workIdOf(seriesIds, favorite.series),
    }),
    userId: itemAt(accountIds, favorite.accountIndex, 'account id'),
    createdAt: favorite.createdAt,
  }));

  // About 25 rows: far below INSERT_BATCH, so one insert.
  await Favorite.bulkCreate(rows, { transaction });
  return rows.length;
}

async function writeLibrary(
  plan: Plan,
  accountIds: readonly number[],
  bookIds: Map<PlannedBook, number>,
  transaction: Transaction
): Promise<number> {
  const rows = plan.library.map((entry) => ({
    status: entry.status,
    userId: itemAt(accountIds, entry.accountIndex, 'account id'),
    bookId: workIdOf(bookIds, entry.book),
    createdAt: entry.updatedAt,
    updatedAt: entry.updatedAt,
  }));

  // About 25 rows: far below INSERT_BATCH, so one insert.
  await LibraryEntry.bulkCreate(rows, { transaction });
  return rows.length;
}

async function writeReadingLists(
  plan: Plan,
  accountIds: readonly number[],
  bookIds: Map<PlannedBook, number>,
  seriesIds: Map<PlannedSeries, number>,
  transaction: Transaction
): Promise<{ readingLists: number; readingListItems: number }> {
  const lists = await ReadingList.bulkCreate(
    plan.readingLists.map((list) => ({
      ...createReadingListSchema.parse({
        title: list.title,
        description: list.description,
        tags: list.tags,
      }),
      userId: itemAt(accountIds, list.accountIndex, 'account id'),
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    })),
    { transaction }
  );

  // bulkCreate returns the rows in input order, so index i is plan list i.
  const items = plan.readingLists.flatMap((list, listIndex) =>
    list.items.map((item, position) => ({
      listId: itemAt(lists, listIndex, 'reading list').id,
      bookId: item.book === null ? null : workIdOf(bookIds, item.book),
      seriesId: item.series === null ? null : workIdOf(seriesIds, item.series),
      position,
    }))
  );
  await ReadingListItem.bulkCreate(items, { transaction });
  return { readingLists: lists.length, readingListItems: items.length };
}

async function countExisting(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const model of CONTENT_MODELS) {
    counts[model.tableName] = await model.count();
  }

  return counts;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const config = loadConfig();
  assertSafeTarget(config, force);

  // The same ensure-and-sync steps boot takes outside production, and
  // idempotent, so a fresh clone can seed before the server has ever run.
  await ensureDatabase(config.db);
  const sequelize = createSequelize(config.db);
  try {
    initModels(sequelize);
    await sequelize.authenticate();
    await sequelize.sync();

    if (!force) {
      logger.info(
        `Dry run: pass --force to delete these rows and reseed ${config.db.database}`,
        await countExisting()
      );
      return;
    }

    const plan = buildPlan(createRng(RNG_SEED));

    // One transaction over the delete and every insert: a half-seeded demo is
    // worse than no demo, and a failure here leaves the previous one intact.
    const totals = await sequelize.transaction(async (transaction) => {
      for (const model of CONTENT_MODELS) {
        if (model === Genre) await destroyAllGenres(transaction);
        else await model.destroy({ where: {}, transaction });
      }

      const accountIds = await writeAccounts(plan, transaction);
      const genreIds = await writeGenres(transaction);
      const content = await writeContent(
        plan,
        accountIds,
        genreIds,
        transaction
      );
      const threads = await writeThreads(
        plan,
        accountIds,
        content.bookIds,
        transaction
      );
      const favorites = await writeFavorites(
        plan,
        accountIds,
        content.bookIds,
        content.seriesIds,
        transaction
      );
      const library = await writeLibrary(
        plan,
        accountIds,
        content.bookIds,
        transaction
      );
      const readingLists = await writeReadingLists(
        plan,
        accountIds,
        content.bookIds,
        content.seriesIds,
        transaction
      );
      const notifications = await writeNotifications(
        plan,
        accountIds,
        content.bookIds,
        content.seriesIds,
        transaction
      );

      const reports = await writeReports(
        plan,
        accountIds,
        threads.commentIds,
        transaction
      );

      return {
        accounts: accountIds.length,
        genres: genreIds.size,
        series: content.series,
        books: content.bookIds.size,
        chapters: content.chapters,
        comments: threads.comments,
        likes: threads.likes,
        favorites,
        library,
        ...readingLists,
        notifications,
        reports,
      };
    });

    logger.info(`Seeded ${config.db.database}`, totals);
    logger.info(
      `Sign in as superadmin, admin, mhale, ipetrov, nquinn or user1-user5 — password ${DEMO_PASSWORD}. blocked1 (Blocked) and pending1 (Pending) cannot sign in.`
    );
  } finally {
    await sequelize.close();
  }
}

await main().catch((error: unknown) => {
  logger.error('Seeding failed; no rows were written', messageOf(error));
  process.exitCode = 1;
});
