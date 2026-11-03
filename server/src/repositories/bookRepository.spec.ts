process.env.NODE_ENV ??= 'test';

import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import { createSequelize } from '../db/sequelize.ts';
import { ensureDatabase } from '../db/ensureDatabase.ts';
import { testDbConfig } from '../db/testDb.testkit.ts';
import { skipWithoutMysql } from '../db/mysqlProbe.testkit.ts';
import { initModels } from '../models/index.ts';
import { Book } from '../models/Book.ts';
import { BookAuthor } from '../models/BookAuthor.ts';
import { BookCover } from '../models/BookCover.ts';
import { Chapter } from '../models/Chapter.ts';
import { Comment } from '../models/Comment.ts';
import { Favorite } from '../models/Favorite.ts';
import { destroyAllGenres, Genre } from '../models/Genre.ts';
import { LibraryEntry } from '../models/LibraryEntry.ts';
import { Like } from '../models/Like.ts';
import { Series } from '../models/Series.ts';
import { User } from '../models/User.ts';
import { createCreditedSeries } from '../models/creditedBook.testkit.ts';
import {
  AppError,
  NotFoundError,
  StateConflictError,
} from '../types/errors.ts';
import { createSequelizeBookRepository } from './bookRepository.ts';
import { bookRepositoryContract } from './bookRepository.contract.testkit.ts';
import type { Viewer } from './visibility.ts';
import type { PublicBook, WithFavoriteId } from 'shared';

const skip = await skipWithoutMysql();

const owner = {
  login: 'BookOwner',
  email: 'owner@example.com',
  password: 'hunter2hunter2',
  firstName: 'Ola',
  lastName: 'Owner',
  status: 'active' as const,
};

const coAuthor = {
  login: 'CoAuthor',
  email: 'coauthor@example.com',
  password: 'hunter2hunter2',
  firstName: 'Cora',
  lastName: 'Author',
};

describe('bookRepository against real MySQL', { skip }, () => {
  let sequelize: Sequelize;
  let ownerId: number;
  let seriesId: number;
  // Who acts in the calls below. The rules on who may act are the
  // controllers'; this suite is about what each change does.
  const asOwner = () => ({ id: ownerId, role: 'author' as const });
  const repository = createSequelizeBookRepository();

  // A book every list shows: the filter tests below are about their filters,
  // not about Draft books, which get suites of their own.
  const createPublished = async (
    input: Parameters<typeof repository.create>[0]
  ) => {
    const created = await repository.create(input);
    await repository.update(created.id, { status: 'in_progress' });
    return created;
  };

  // A reorder that lost a race sees a changed set: a 409, never a database
  // error (a deadlock surfaces as a DatabaseError).
  const assertNoDbError = (results: PromiseSettledResult<unknown>[]) => {
    for (const result of results) {
      assert.ok(
        result.status === 'fulfilled' ||
          result.reason instanceof StateConflictError,
        String(result.status === 'rejected' && result.reason)
      );
    }
  };

  const listAsGuest = (query: Parameters<typeof repository.list>[0]) =>
    repository.list(query, null);

  before(async () => {
    const db = testDbConfig('books');
    await ensureDatabase(db);
    sequelize = createSequelize(db);
    initModels(sequelize);
    await sequelize.sync({ force: true });
  });

  after(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    // Children first: the foreign keys forbid clearing users out from under
    // them.
    await Book.destroy({ where: {}, truncate: false });
    await destroyAllGenres();
    await Series.destroy({ where: {}, truncate: false });
    await User.destroy({ where: {}, truncate: false });
    ownerId = (await User.create(owner)).id;
    seriesId = (
      await createCreditedSeries(
        { title: 'Test Series', description: 'A trilogy', tags: [] },
        [ownerId]
      )
    ).id;
  });

  test('creating a book credits its creator as its only co-author', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Solo',
      tags: [],
    });

    assert.deepEqual(created.authors, [
      {
        id: ownerId,
        login: 'BookOwner',
        firstName: 'Ola',
        lastName: 'Owner',
        status: 'active',
        avatarUrl: null,
      },
    ]);
    assert.deepEqual((await repository.findById(created.id))?.authors, [
      {
        id: ownerId,
        login: 'BookOwner',
        firstName: 'Ola',
        lastName: 'Owner',
        status: 'active',
        avatarUrl: null,
      },
    ]);
  });

  test('a new book starts as a draft and moves through every status', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Status',
      tags: [],
    });
    assert.equal(created.status, 'draft');

    for (const status of ['complete', 'in_progress', 'draft'] as const) {
      assert.equal(
        (await repository.update(created.id, { status }))?.status,
        status
      );
    }
  });

  test('a Draft turning Published marks its already-out chapters announced, without new-chapter notifications', async () => {
    const draft = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Draft with a head start',
      description: 'Chapters already out',
      tags: [],
    });
    const out = await Chapter.create({
      bookId: draft.id,
      title: 'Chapter 1',
      text: 'already out',
      publishedAt: daysFromNow(-1),
      position: 1,
    });
    const notYet = await Chapter.create({
      bookId: draft.id,
      title: 'Chapter 2',
      text: 'not out yet',
      publishedAt: daysFromNow(1),
      position: 2,
    });

    await repository.update(draft.id, { status: 'in_progress' });

    // Marked announced directly here, not by the announcement pass: the pass
    // only raises the New book (books.announcedAt), and would otherwise send
    // a New chapter notification for a chapter whose moment already passed.
    const [announced, scheduled] = await Promise.all([
      Chapter.findByPk(out.id),
      Chapter.findByPk(notYet.id),
    ]);
    assert.ok(announced?.announcedAt);
    assert.equal(scheduled?.announcedAt, null);
  });

  test('no list shows a draft, except the caller listing their own books', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const draft = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Draft',
      description: 'Private',
      tags: [],
    });
    await repository.addCoAuthor(draft.id, coAuthorId, asOwner());
    const published = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Published',
      description: 'Public',
      tags: [],
    });
    await repository.update(published.id, { status: 'in_progress' });

    const titles = async (
      query: { userId?: number },
      viewer: Viewer
    ): Promise<string[]> =>
      (
        await repository.list({ current: 1, pageSize: 20, ...query }, viewer)
      ).items.map((book) => book.title);

    const owner: Viewer = { id: ownerId, role: 'author' };
    const moderator: Viewer = { id: coAuthorId + 1_000, role: 'superadmin' };

    assert.deepEqual(await titles({}, null), ['Published']);
    assert.deepEqual(await titles({}, owner), ['Published']);
    assert.deepEqual(await titles({}, moderator), ['Published']);
    assert.deepEqual(await titles({ userId: ownerId }, moderator), [
      'Published',
    ]);
    // Their own list, and a shared draft shows for either Co-author.
    assert.deepEqual(await titles({ userId: ownerId }, owner), [
      'Draft',
      'Published',
    ]);
    assert.deepEqual(
      await titles({ userId: coAuthorId }, { id: coAuthorId, role: 'author' }),
      ['Draft']
    );
  });

  test('a draft is readable by its co-authors and moderators, and nobody else', async () => {
    const draft = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Draft',
      description: 'Private',
      tags: [],
    });
    const stranger = ownerId + 1_000;

    const readable = async (viewer: Viewer): Promise<boolean> =>
      (await repository.findDetailById(draft.id, viewer)) !== null;

    assert.equal(await readable(null), false);
    assert.equal(await readable({ id: stranger, role: 'user' }), false);
    assert.equal(await readable({ id: stranger, role: 'author' }), false);
    assert.equal(await readable({ id: ownerId, role: 'author' }), true);
    assert.equal(await readable({ id: stranger, role: 'admin' }), true);
    assert.equal(await readable({ id: stranger, role: 'superadmin' }), true);

    await repository.update(draft.id, { status: 'complete' });
    assert.equal(await readable(null), true);
  });

  test('a co-author is credited after the ones already there', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });

    const updated = await repository.addCoAuthor(
      created.id,
      coAuthorId,
      asOwner()
    );

    assert.deepEqual(
      updated?.authors.map((author) => author.login),
      ['BookOwner', 'CoAuthor']
    );
    assert.deepEqual(
      (await repository.findById(created.id))?.authors.map((a) => a.id),
      [ownerId, coAuthorId]
    );
  });

  test('only an account holding the author role can be made a co-author', async () => {
    const readerId = (await User.create({ ...coAuthor, role: 'user' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });

    await assert.rejects(
      repository.addCoAuthor(created.id, readerId, asOwner()),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 400 &&
        /author role/i.test(error.message)
    );
    assert.equal((await repository.findById(created.id))?.authors.length, 1);
  });

  test('crediting an account that does not exist blames the user', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });

    await assert.rejects(
      repository.addCoAuthor(created.id, ownerId + 10_000, asOwner()),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /User \d+ not found/.test(error.message)
    );
  });

  test('crediting a co-author twice is a conflict', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(created.id, coAuthorId, asOwner());

    await assert.rejects(
      repository.addCoAuthor(created.id, coAuthorId, asOwner()),
      (error: unknown) => error instanceof AppError && error.statusCode === 409
    );
    assert.equal((await repository.findById(created.id))?.authors.length, 2);
  });

  test('removing a co-author leaves the rest credited', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(created.id, coAuthorId, asOwner());

    const updated = await repository.removeCoAuthor(
      created.id,
      ownerId,
      asOwner()
    );

    assert.deepEqual(
      updated?.authors.map((author) => author.id),
      [coAuthorId]
    );
  });

  test('the last co-author cannot be removed', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Solo',
      tags: [],
    });

    await assert.rejects(
      repository.removeCoAuthor(created.id, ownerId, asOwner()),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 409 &&
        /last co-author/i.test(error.message)
    );
    assert.equal((await repository.findById(created.id))?.authors.length, 1);
  });

  test('removing an account that is not credited is a 404, even on a solo book', async () => {
    const strangerId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Solo',
      tags: [],
    });

    // A solo book, so a "last co-author" 409 would be the wrong answer: the
    // stranger was never credited, and the owner's credit is untouched.
    await assert.rejects(
      repository.removeCoAuthor(created.id, strangerId, asOwner()),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Co-author \d+ not found/.test(error.message)
    );
  });

  test('ids lists only the Published Books among those named, for every viewer', async () => {
    const MISSING_ID = 999_999;
    const live = await publishedBook('Live');
    const otherLive = await publishedBook('Other live');
    const draft = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Hidden draft',
      description: 'd',
      tags: [],
    });

    for (const viewer of [
      asOwner(),
      { id: 0, role: 'superadmin' as const },
      null,
    ]) {
      const named = await repository.list(
        {
          current: 1,
          pageSize: 20,
          ids: [live.id, draft.id, MISSING_ID],
        },
        viewer
      );
      assert.deepEqual(
        named.items.map((book) => book.title),
        ['Live']
      );
      assert.equal(named.total, 1);

      const paged = await repository.list(
        { current: 1, pageSize: 1, ids: [live.id, otherLive.id] },
        viewer
      );
      assert.equal(paged.total, 2);
      assert.equal(paged.items.length, 1);
    }
  });

  test('published=true drops the Drafts that ?userId= lists for their own Co-author, whoever asks', async () => {
    await publishedBook('Live');
    await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Hidden draft',
      description: 'd',
      tags: [],
    });
    const titlesFor = async (viewer: Viewer, published?: 'true') =>
      (
        await repository.list(
          { current: 1, pageSize: 20, userId: ownerId, published },
          viewer
        )
      ).items
        .map((book) => book.title)
        .sort();

    assert.deepEqual(await titlesFor(asOwner()), ['Hidden draft', 'Live']);
    for (const viewer of [
      asOwner(),
      { id: 0, role: 'superadmin' as const },
      null,
    ]) {
      assert.deepEqual(await titlesFor(viewer, 'true'), ['Live']);
    }
  });

  // What every `own` check on a book asks (coAuthorGuard).
  test('findCoAuthorIds lists the co-authors in credit order, and null for a missing book', async () => {
    const earlierId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const laterId = (
      await User.create({
        ...coAuthor,
        login: 'LaterAuthor',
        email: 'later@example.com',
        role: 'author',
      })
    ).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });
    // Credited against the order the accounts were made in, so a list sorted
    // by user id would come back the other way round.
    await repository.addCoAuthor(created.id, laterId, asOwner());
    await repository.addCoAuthor(created.id, earlierId, asOwner());

    assert.deepEqual(await repository.findCoAuthorIds(created.id), [
      ownerId,
      laterId,
      earlierId,
    ]);
    assert.equal(await repository.findCoAuthorIds(created.id + 10_000), null);
  });

  // What filing a book into a series asks (bookController.assertMayAddToSeries).
  test('findSeriesCoAuthorIds lists the series co-authors in credit order, and null for a missing series', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const shared = await createCreditedSeries(
      { title: 'Shared Series', description: 'x', tags: [] },
      [coAuthorId, ownerId]
    );

    assert.deepEqual(await repository.findSeriesCoAuthorIds(shared.id), [
      coAuthorId,
      ownerId,
    ]);
    assert.equal(
      await repository.findSeriesCoAuthorIds(shared.id + 10_000),
      null
    );
  });

  // Only the unique index's rejection means "already credited". An account
  // deleted between the lookup and the insert fails the foreign key instead,
  // which is answered as 404 on the user, not as a misleading 409.
  test('an account deleted between the lookup and the insert is a missing user, not a conflict', async () => {
    const doomedId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });

    BookAuthor.addHook('beforeCreate', 'deleteAccount', async () => {
      await User.destroy({ where: { id: doomedId } });
    });
    try {
      await assert.rejects(
        repository.addCoAuthor(created.id, doomedId, asOwner()),
        (error: unknown) =>
          error instanceof NotFoundError &&
          /User \d+ not found/.test(error.message)
      );
    } finally {
      BookAuthor.removeHook('beforeCreate', 'deleteAccount');
    }
    assert.deepEqual(await repository.findCoAuthorIds(created.id), [ownerId]);
  });

  test('two co-authors of a two-author book leaving at once: one leaves, one gets a conflict', async () => {
    const otherId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(created.id, otherId, asOwner());

    const results = await Promise.allSettled([
      repository.removeCoAuthor(created.id, ownerId, asOwner()),
      repository.removeCoAuthor(created.id, otherId, {
        id: otherId,
        role: 'author',
      }),
    ]);

    assert.deepEqual(results.map((r) => r.status).sort(), [
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected && rejected.reason instanceof StateConflictError);
    assert.equal((await repository.findCoAuthorIds(created.id))?.length, 1);
  });

  // update peeks seriesId unlocked, then locks and re-reads the book. A move
  // in between (here: the afterFind hook, on the unlocked peek only) is a 409.
  test('updating a book that moved to another series since the peek is a state conflict', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Before',
      description: 'Solo',
      tags: [],
    });

    let moved = false;
    Book.addHook('afterFind', 'moveAfterPeek', async (_found, options) => {
      if (moved || options.transaction) return;
      moved = true;
      await Book.update(
        { seriesId },
        { where: { id: created.id }, hooks: false }
      );
    });
    try {
      await assert.rejects(
        repository.update(created.id, { title: 'After' }),
        (error: unknown) =>
          error instanceof StateConflictError &&
          error.message === 'The book was moved to another series; try again'
      );
    } finally {
      Book.removeHook('afterFind', 'moveAfterPeek');
    }

    assert.equal(moved, true);
    const row = await Book.findByPk(created.id);
    assert.equal(row?.title, 'Before');
    assert.equal(row?.seriesId, seriesId);
  });

  test('crediting a co-author while the work is deleted never fails unmapped', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Shared',
      tags: [],
    });

    const [added] = await Promise.allSettled([
      repository.addCoAuthor(created.id, coAuthorId, asOwner()),
      repository.remove(created.id, asOwner()),
    ]);

    assert.equal(added.status, 'fulfilled'); // the book, or null once it is gone
  });

  test('the userId filter matches a book through any of its co-authors', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const shared = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Shared Book',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(shared.id, coAuthorId, asOwner());
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Solo Book',
      description: 'Solo',
      tags: [],
    });

    const page = await listAsGuest({
      current: 1,
      pageSize: 20,
      userId: coAuthorId,
    });

    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.title, 'Shared Book');
    assert.equal(
      (await listAsGuest({ current: 1, pageSize: 20, userId: ownerId })).total,
      2
    );
  });

  test('round-trips tags through the JSON column as a real array', async () => {
    const created = await createPublished({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'Book one',
      tags: ['sci-fi', 'epic'],
    });

    const reloaded = await repository.findById(created.id);

    assert.ok(Array.isArray(reloaded?.tags));
    assert.deepEqual(reloaded?.tags, ['sci-fi', 'epic']);
    assert.equal(reloaded?.seriesId, seriesId);
  });

  test('stores a standalone book with a null seriesId', async () => {
    const created = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Standalone',
      tags: [],
    });

    assert.equal(created.seriesId, null);
    assert.equal((await repository.findById(created.id))?.seriesId, null);
  });

  test('tags survive multi-byte characters, thanks to utf8mb4', async () => {
    const created = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Epic 📚',
      tags: ['sci-fi', '📚'],
    });

    const reloaded = await repository.findById(created.id);

    assert.equal(reloaded?.description, 'Epic 📚');
    assert.deepEqual(reloaded?.tags, ['sci-fi', '📚']);
  });

  test('a create against an unknown user surfaces as NotFoundError, not a raw FK error', async () => {
    await assert.rejects(
      repository.create({
        userId: ownerId + 10_000,
        seriesId: null,
        title: 'Test Book',
        description: 'Orphan',
        tags: [],
      }),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /User \d+ not found/.test(error.message)
    );
  });

  // The two foreign keys are only distinguishable through MySQL's constraint
  // text, so this asserts the repository blames the right one — a "User not
  // found" here would send the caller hunting for a user that exists.
  test('a create against an unknown series blames the series, not the user', async () => {
    await assert.rejects(
      repository.create({
        userId: ownerId,
        seriesId: seriesId + 10_000,
        title: 'Test Book',
        description: 'Orphan',
        tags: [],
      }),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Series \d+ not found/.test(error.message)
    );
  });

  test('an update to an unknown series is a NotFoundError on the series', async () => {
    const created = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Standalone',
      tags: [],
    });

    await assert.rejects(
      repository.update(created.id, { seriesId: seriesId + 10_000 }),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Series \d+ not found/.test(error.message)
    );
  });

  test('the tag filter matches through JSON_CONTAINS, not a substring', async () => {
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Tagged epic',
      tags: ['epic'],
    });
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Tagged epic-fantasy',
      tags: ['epic-fantasy'],
    });

    const exact = await listAsGuest({ current: 1, pageSize: 20, tag: 'epic' });

    // A LIKE-based implementation would return both rows here.
    assert.equal(exact.total, 1);
    assert.equal(exact.items[0]?.description, 'Tagged epic');
  });

  test('the genre filter returns that genre alone, and an unknown id returns nothing', async () => {
    const gothic = await Genre.create({ name: 'Filter Gothic' });
    const hardSf = await Genre.create({ name: 'Filter Hard SF' });
    const filed = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'In Gothic',
      description: 'A',
      tags: [],
      genreId: gothic.id,
    });
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'In Hard SF',
      description: 'B',
      tags: [],
      genreId: hardSf.id,
    });
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'No Genre',
      description: 'C',
      tags: [],
    });

    const inGothic = await listAsGuest({
      current: 1,
      pageSize: 20,
      genreId: gothic.id,
    });
    const inMissing = await listAsGuest({
      current: 1,
      pageSize: 20,
      genreId: 999_999,
    });

    assert.deepEqual(
      inGothic.items.map((item) => item.id),
      [filed.id]
    );
    assert.equal(inGothic.items[0]?.genre?.name, 'Filter Gothic');
    assert.equal(inMissing.total, 0);
  });

  test('the genre filter on a top-level Genre also returns its Subgenres’ books; a Subgenre matches only itself', async () => {
    const fantasy = await Genre.create({ name: 'Family Fantasy' });
    const urban = await Genre.create({
      name: 'Family Urban',
      parentId: fantasy.id,
    });
    const horror = await Genre.create({ name: 'Family Horror' });
    const make = (title: string, genreId: number) =>
      createPublished({
        userId: ownerId,
        seriesId: null,
        title,
        description: 'x',
        tags: [],
        genreId,
      });
    const top = await make('Top', fantasy.id);
    const sub = await make('Sub', urban.id);
    await make('Elsewhere', horror.id);

    const byTop = await listAsGuest({
      current: 1,
      pageSize: 20,
      genreId: fantasy.id,
    });
    const bySub = await listAsGuest({
      current: 1,
      pageSize: 20,
      genreId: urban.id,
    });

    assert.deepEqual(
      byTop.items.map((item) => item.id).sort(),
      [top.id, sub.id].sort()
    );
    assert.deepEqual(
      bySub.items.map((item) => item.id),
      [sub.id]
    );
    assert.equal(bySub.items[0]?.genre?.parent?.name, 'Family Fantasy');
  });

  test('list finds a book by its title', async () => {
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'The Dragon Gate',
      description: 'unrelated prose',
      tags: [],
    });

    const { items } = await listAsGuest({
      current: 1,
      pageSize: 20,
      q: 'Dragon Gate',
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'The Dragon Gate');
  });

  test('the description search treats LIKE metacharacters literally', async () => {
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Contains a 100% real percent sign',
      tags: [],
    });
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'No metacharacter here',
      tags: [],
    });

    const matches = await listAsGuest({ current: 1, pageSize: 20, q: '%' });

    assert.equal(matches.total, 1);
    assert.match(matches.items[0]?.description ?? '', /100% real/);
  });

  const publish = (title: string, description = 'x') =>
    createPublished({
      userId: ownerId,
      seriesId: null,
      title,
      description,
      tags: [],
    });

  const seedRings = async () => {
    for (const title of ['Ring A', 'Ring B', 'Ring C']) {
      await publish(title);
    }
  };

  test('the search finds a book by a substring of its title', async () => {
    await publish('Rings');
    await publish('Other', 'y');

    const page = await listAsGuest({ current: 1, pageSize: 20, q: 'ring' });

    assert.deepEqual(
      page.items.map((item) => item.title),
      ['Rings']
    );
    assert.equal(page.total, 1);
  });

  test('a page past the end with q set serves the last non-empty page', async () => {
    await seedRings();
    await publish('Other', 'y');

    const page = await listAsGuest({ current: 9, pageSize: 2, q: 'ring' });

    assert.equal(page.current, 2);
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.items.map((item) => item.title),
      ['Ring C']
    );
  });

  test('nothing matching serves page 1, empty, even when a later page is asked', async () => {
    await publish('Other', 'y');

    for (const current of [1, 2, 5]) {
      const page = await listAsGuest({ current, pageSize: 2, q: 'zzz' });
      assert.deepEqual(
        { items: page.items, total: page.total, current: page.current },
        { items: [], total: 0, current: 1 }
      );
    }
  });

  test('a page in range costs one books query, and no item carries the window total', async () => {
    await seedRings();
    const bookSelects: string[] = [];
    // AbstractQuery's typings omit `sql`, hence the cast.
    const hook = (_options: unknown, query: object) => {
      const { sql = '' } = query as { sql?: string };
      if (/^SELECT .* FROM `books` AS `Book`/s.test(sql)) {
        bookSelects.push(sql);
      }
    };
    // afterQuery: Sequelize 6 sets `query.sql` only inside `query.run`.
    sequelize.addHook('afterQuery', 'countBookSelects', hook);
    try {
      const page = await listAsGuest({ current: 1, pageSize: 2, q: 'ring' });
      assert.equal(typeof page.total, 'number');
      assert.equal(page.total, 3);
      assert.equal(page.items.length, 2);
      assert.ok(page.items.every((item) => !('total' in item)));
      assert.equal(bookSelects.length, 1, bookSelects.join('\n'));
    } finally {
      sequelize.removeHook('afterQuery', 'countBookSelects');
    }
  });

  const DAY = 24 * 60 * 60 * 1000;
  const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);

  const publishedBook = (title: string) =>
    createPublished({
      userId: ownerId,
      seriesId: null,
      title,
      description: title,
      tags: [],
    });

  const addChapters = (bookId: number, publishedAt: (Date | null)[]) =>
    Chapter.bulkCreate(
      publishedAt.map((at, index) => ({
        bookId,
        title: `Chapter ${index + 1}`,
        text: 'text',
        publishedAt: at,
        position: index + 1,
      }))
    );

  describe('sorted lists', () => {
    const reactTo = async (bookId: number, isLikes: boolean[]) => {
      for (const [index, isLike] of isLikes.entries()) {
        const reader = await User.create({
          login: `reader${bookId}x${index}`,
          email: `reader${bookId}x${index}@example.com`,
          password: 'hunter2hunter2',
          firstName: 'Rea',
          lastName: 'Der',
        });
        await Like.create({ userId: reader.id, bookId, isLike });
      }
    };

    const sortedTitles = async (sort: 'popular' | 'new' | 'updated') => {
      const page = await listAsGuest({ current: 1, pageSize: 20, sort });
      return {
        titles: page.items.map((book) => book.title),
        total: page.total,
      };
    };

    test('popular ranks by likes on the book, dislikes aside, ties newest first', async () => {
      const loved = await publishedBook('Loved');
      const mixed = await publishedBook('Mixed');
      await publishedBook('Quiet');
      await publishedBook('Quieter');
      await reactTo(loved.id, [true, true]);
      await reactTo(mixed.id, [true, false, false, false]);

      assert.deepEqual(await sortedTitles('popular'), {
        titles: ['Loved', 'Mixed', 'Quieter', 'Quiet'],
        total: 4,
      });
    });

    test('new ranks by the earliest published chapter and lists books with nothing published last', async () => {
      const older = await publishedBook('Older');
      const newer = await publishedBook('Newer');
      const scheduled = await publishedBook('Scheduled only');
      await publishedBook('No chapters');
      await addChapters(older.id, [daysFromNow(-3), daysFromNow(-1)]);
      await addChapters(newer.id, [daysFromNow(-2), null]);
      await addChapters(scheduled.id, [daysFromNow(1), null]);

      // The two without a Release time follow, newest id first.
      assert.deepEqual(await sortedTitles('new'), {
        titles: ['Newer', 'Older', 'No chapters', 'Scheduled only'],
        total: 4,
      });
    });

    test('updated ranks by the latest published chapter, a scheduled one aside, and lists books with nothing published last', async () => {
      const older = await publishedBook('Older');
      const newer = await publishedBook('Newer');
      await publishedBook('No chapters');
      await addChapters(older.id, [daysFromNow(-3), daysFromNow(-1)]);
      await addChapters(newer.id, [daysFromNow(-2), daysFromNow(1)]);

      assert.deepEqual(await sortedTitles('updated'), {
        titles: ['Older', 'Newer', 'No chapters'],
        total: 3,
      });
    });

    test('a range filter still leaves out a book with nothing published, sorted or not', async () => {
      const dated = await publishedBook('Dated');
      await publishedBook('No chapters');
      await addChapters(dated.id, [daysFromNow(-2)]);

      const page = await listAsGuest({
        current: 1,
        pageSize: 20,
        sort: 'new',
        releasedFrom: daysFromNow(-5),
      });

      assert.deepEqual(
        page.items.map((book) => book.title),
        ['Dated']
      );
    });
  });

  describe('detail tallies', () => {
    const addChapter = (
      bookId: number,
      position: number,
      text: string,
      publishedAt: Date | null
    ) =>
      Chapter.create({
        bookId,
        title: `Chapter ${position}`,
        text,
        publishedAt,
        position,
      });

    const comment = (
      bookId: number,
      text: string,
      fields: { parentId?: number; tombstone?: 'deleted' | 'removed' } = {}
    ) => Comment.create({ userId: ownerId, bookId, text, ...fields });

    test('commentCount counts live comments, roots and replies, and no tombstone', async () => {
      const book = await publishedBook('Talked about');
      const root = await comment(book.id, 'Root');
      await comment(book.id, 'Reply', { parentId: root.id });
      const deleted = await comment(book.id, 'Deleted', {
        tombstone: 'deleted',
      });
      // A live reply under a tombstone still counts.
      await comment(book.id, 'Reply to a tombstone', { parentId: deleted.id });
      await comment(book.id, 'Removed', { tombstone: 'removed' });
      const elsewhere = await publishedBook('Elsewhere');
      await comment(elsewhere.id, 'Not on this book');

      const detail = await repository.findDetailById(book.id, null);

      assert.equal(detail?.commentCount, 3);
    });

    test('wordCount sums Published chapters only, whoever reads the book', async () => {
      const book = await publishedBook('Counted');
      await addChapter(book.id, 1, 'one two three', daysFromNow(-2));
      await addChapter(book.id, 2, 'four  five\n', daysFromNow(-1));
      await addChapter(book.id, 3, 'a draft the readers never see', null);
      await addChapter(book.id, 4, 'scheduled for later on', daysFromNow(1));

      // A Co-author and a Moderator see the Draft and Scheduled chapters, but
      // the figure is the readers' one for everybody.
      const viewers: Viewer[] = [
        null,
        { id: ownerId + 1_000, role: 'user' },
        { id: ownerId, role: 'author' },
        { id: ownerId + 1_000, role: 'admin' },
      ];
      for (const viewer of viewers) {
        assert.equal(
          (await repository.findDetailById(book.id, viewer))?.wordCount,
          5,
          JSON.stringify(viewer)
        );
      }
    });

    test('a Draft book read by its Co-author counts only the chapters already out', async () => {
      const draft = await repository.create({
        userId: ownerId,
        seriesId: null,
        title: 'Draft',
        description: 'Private',
        tags: [],
      });
      await addChapter(draft.id, 1, 'out already', daysFromNow(-1));
      await addChapter(draft.id, 2, 'not out yet', null);

      const detail = await repository.findDetailById(draft.id, {
        id: ownerId,
        role: 'author',
      });

      assert.equal(detail?.wordCount, 2);
    });

    test('a book with only Draft and Scheduled chapters counts zero words, not null', async () => {
      const book = await publishedBook('Nothing out');
      await addChapter(book.id, 1, 'a draft', null);
      await addChapter(book.id, 2, 'coming soon', daysFromNow(1));

      const detail = await repository.findDetailById(book.id, {
        id: ownerId,
        role: 'author',
      });

      assert.equal(detail?.wordCount, 0);
    });

    let fanCount = 0;
    const aFan = async () => {
      fanCount += 1;
      return User.create({
        login: `BookFan${fanCount}`,
        email: `book-fan-${fanCount}@example.com`,
        password: 'hunter2hunter2',
        firstName: 'Book',
        lastName: `Fan${fanCount}`,
      });
    };

    test("favoriteCount counts every holder, and viewerFavoriteId names the viewer's own", async () => {
      const book = await publishedBook('Treasured');
      const elsewhere = await publishedBook('Elsewhere');
      const fan = await aFan();
      const otherFan = await aFan();
      const own = await Favorite.create({ userId: fan.id, bookId: book.id });
      await Favorite.create({ userId: otherFan.id, bookId: book.id });
      await Favorite.create({ userId: fan.id, bookId: elsewhere.id });

      const asFan = await repository.findDetailById(book.id, {
        id: fan.id,
        role: 'user',
      });
      const asGuest = await repository.findDetailById(book.id, null);
      const asCoAuthor = await repository.findDetailById(book.id, asOwner());

      assert.deepEqual(
        [asFan?.favoriteCount, asFan?.viewerFavoriteId],
        [2, own.id]
      );
      assert.deepEqual(
        [asGuest?.favoriteCount, asGuest?.viewerFavoriteId],
        [2, null]
      );
      assert.equal(asCoAuthor?.viewerFavoriteId, null);
    });

    test('libraryCounts count each status, leave Not interested out, and viewerReadingStatus is the viewer own', async () => {
      const reading = await aFan();
      const planned = await aFan();
      const finished = await aFan();
      const skipped = await aFan();
      const book = await publishedBook('Shelved');
      await LibraryEntry.create({
        userId: reading.id,
        bookId: book.id,
        status: 'reading',
      });
      await LibraryEntry.create({
        userId: planned.id,
        bookId: book.id,
        status: 'plan_to_read',
      });
      await LibraryEntry.create({
        userId: finished.id,
        bookId: book.id,
        status: 'read',
      });
      await LibraryEntry.create({
        userId: skipped.id,
        bookId: book.id,
        status: 'not_interested',
      });

      const asReading = await repository.findDetailById(book.id, {
        id: reading.id,
        role: 'user',
      });
      const asSkipped = await repository.findDetailById(book.id, {
        id: skipped.id,
        role: 'user',
      });
      const asGuest = await repository.findDetailById(book.id, null);

      const counts = { reading: 1, planToRead: 1, read: 1, inLibraries: 3 };
      assert.deepEqual(asReading?.libraryCounts, counts);
      assert.deepEqual(asGuest?.libraryCounts, counts);
      assert.deepEqual(asSkipped?.libraryCounts, counts);
      assert.deepEqual(
        [
          asReading?.viewerReadingStatus,
          asSkipped?.viewerReadingStatus,
          asGuest?.viewerReadingStatus,
        ],
        ['reading', 'not_interested', null]
      );
    });

    test('a Draft Book counts no Library, but its Co-author still sees their own status', async () => {
      const draft = await repository.create({
        userId: ownerId,
        seriesId: null,
        title: 'Hidden',
        description: 'Hidden',
        tags: [],
      });
      await LibraryEntry.create({
        userId: ownerId,
        bookId: draft.id,
        status: 'reading',
      });

      const detail = await repository.findDetailById(draft.id, asOwner());

      assert.deepEqual(detail?.libraryCounts, {
        reading: 0,
        planToRead: 0,
        read: 0,
        inLibraries: 0,
      });
      assert.equal(detail?.viewerReadingStatus, 'reading');
    });

    test('favoritedBy=me lists only the viewer own Favorites, each with its favoriteId', async () => {
      const mine = await publishedBook('Mine');
      const theirs = await publishedBook('Theirs');
      await publishedBook('Nobody');
      const fan = await aFan();
      const other = await aFan();
      const row = await Favorite.create({ userId: fan.id, bookId: mine.id });
      await Favorite.create({ userId: other.id, bookId: theirs.id });
      await Favorite.create({ userId: other.id, bookId: mine.id });

      const page = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me' },
        { id: fan.id, role: 'user' }
      );

      assert.deepEqual(
        page.items.map((item) => item.id),
        [mine.id]
      );
      assert.equal(page.total, 1);
      assert.equal(
        (page.items[0] as WithFavoriteId<PublicBook>).favoriteId,
        row.id
      );
    });

    test('favoritedBy=me with no Favorites, or with no viewer, matches nothing', async () => {
      await publishedBook('Unloved');
      const fan = await aFan();

      const none = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me' },
        { id: fan.id, role: 'user' }
      );
      const guest = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me' },
        null
      );

      assert.deepEqual([none.total, guest.total], [0, 0]);
    });

    test('favoritedBy=me combines by AND with q, the genre filter and paging', async () => {
      const genre = await Genre.create({ name: 'Favorites Genre' });
      const make = (title: string, genreId?: number) =>
        createPublished({
          userId: ownerId,
          seriesId: null,
          title,
          description: title,
          tags: [],
          genreId,
        });
      const alpha = await make('Dragon Alpha', genre.id);
      const beta = await make('Dragon Beta');
      const gamma = await make('Quiet Gamma', genre.id);
      await make('Dragon Delta', genre.id);
      const fan = await aFan();
      const viewer = { id: fan.id, role: 'user' } as const;
      for (const book of [alpha, beta, gamma]) {
        await Favorite.create({ userId: fan.id, bookId: book.id });
      }
      const base = { current: 1, pageSize: 20, favoritedBy: 'me' } as const;

      const byText = await repository.list({ ...base, q: 'Dragon' }, viewer);
      const byBoth = await repository.list(
        { ...base, q: 'Dragon', genreId: genre.id },
        viewer
      );
      const paged = await repository.list(
        { ...base, q: 'Dragon', pageSize: 1 },
        viewer
      );

      assert.deepEqual(
        byText.items.map((item) => item.id).sort(),
        [alpha.id, beta.id].sort()
      );
      assert.deepEqual(
        byBoth.items.map((item) => item.id),
        [alpha.id]
      );
      assert.deepEqual([paged.total, paged.items.length], [2, 1]);
    });

    test('a favorited book turned Draft leaves the reader list; its own Co-author still sees it with userId', async () => {
      const book = await publishedBook('Withdrawn');
      const fan = await aFan();
      await Favorite.create({ userId: fan.id, bookId: book.id });
      await Favorite.create({ userId: ownerId, bookId: book.id });
      await repository.update(book.id, { status: 'draft' });

      const asFan = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me' },
        { id: fan.id, role: 'user' }
      );
      const asOwnerAlone = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me' },
        asOwner()
      );
      const asOwnerOwn = await repository.list(
        { current: 1, pageSize: 20, favoritedBy: 'me', userId: ownerId },
        asOwner()
      );

      assert.equal(asFan.total, 0);
      assert.equal(asOwnerAlone.total, 0);
      assert.deepEqual(
        asOwnerOwn.items.map((item) => item.id),
        [book.id]
      );
    });

    describe('hideNotInterested', () => {
      const seedLibrary = async () => {
        const hidden = await publishedBook('Hidden');
        const reading = await publishedBook('Reading');
        const plain = await publishedBook('Plain');
        const others = await publishedBook('Others');
        const viewer = await aFan();
        const other = await aFan();
        await LibraryEntry.create({
          userId: viewer.id,
          bookId: hidden.id,
          status: 'not_interested',
        });
        await LibraryEntry.create({
          userId: viewer.id,
          bookId: reading.id,
          status: 'reading',
        });
        await LibraryEntry.create({
          userId: other.id,
          bookId: plain.id,
          status: 'not_interested',
        });
        return {
          hidden,
          reading,
          plain,
          others,
          viewer: { id: viewer.id, role: 'user' } as const,
        };
      };
      const flagged = {
        current: 1,
        pageSize: 20,
        hideNotInterested: 'true',
      } as const;

      test("leaves out the viewer's not_interested Books only", async () => {
        const { reading, plain, others, viewer } = await seedLibrary();

        const page = await repository.list(flagged, viewer);

        assert.deepEqual(
          new Set(page.items.map((item) => item.id)),
          new Set([reading.id, plain.id, others.id])
        );
        assert.equal(page.total, 3);
      });

      test('combines with another filter', async () => {
        const { reading, plain, viewer } = await seedLibrary();

        // 'n' is in Hidden, Reading and Plain, not in Others.
        const page = await repository.list({ ...flagged, q: 'n' }, viewer);

        assert.deepEqual(
          new Set(page.items.map((item) => item.id)),
          new Set([reading.id, plain.id])
        );
        assert.equal(page.total, 2);
      });

      test('is ignored for a Guest', async () => {
        await seedLibrary();

        const page = await repository.list(flagged, null);

        assert.equal(page.items.length, 4);
        assert.equal(page.total, 4);
      });

      test('without any not_interested entry changes nothing', async () => {
        await publishedBook('One');
        await publishedBook('Two');
        const fan = await aFan();
        const viewer = { id: fan.id, role: 'user' } as const;

        const plain = await repository.list(
          { current: 1, pageSize: 20 },
          viewer
        );
        const page = await repository.list(flagged, viewer);

        assert.equal(plain.total, 2);
        assert.equal(page.total, 2);
      });

      test('keeps total and paging consistent', async () => {
        const fan = await aFan();
        for (const title of ['A', 'B', 'C']) await publishedBook(title);
        for (const title of ['X', 'Y']) {
          const book = await publishedBook(title);
          await LibraryEntry.create({
            userId: fan.id,
            bookId: book.id,
            status: 'not_interested',
          });
        }
        const viewer = { id: fan.id, role: 'user' } as const;

        const first = await repository.list(
          { current: 1, pageSize: 2, hideNotInterested: 'true' },
          viewer
        );
        const second = await repository.list(
          { current: 2, pageSize: 2, hideNotInterested: 'true' },
          viewer
        );

        assert.deepEqual([first.total, second.total], [3, 3]);
        assert.deepEqual([first.items.length, second.items.length], [2, 1]);
      });

      test('without the flag a Not interested Book is still listed', async () => {
        const { viewer } = await seedLibrary();

        const page = await repository.list(
          { current: 1, pageSize: 20 },
          viewer
        );

        assert.equal(page.total, 4);
      });
    });

    test('a Draft book counts no favorites, yet names the viewer own, and republishing counts them again', async () => {
      const book = await publishedBook('Withdrawn');
      const fan = await aFan();
      await Favorite.create({ userId: fan.id, bookId: book.id });
      const own = await Favorite.create({ userId: ownerId, bookId: book.id });

      await repository.update(book.id, { status: 'draft' });
      const asCoAuthor = await repository.findDetailById(book.id, asOwner());
      const asModerator = await repository.findDetailById(book.id, {
        id: fan.id,
        role: 'admin',
      });

      assert.deepEqual(
        [asCoAuthor?.favoriteCount, asCoAuthor?.viewerFavoriteId],
        [0, own.id]
      );
      assert.equal(asModerator?.favoriteCount, 0);
      assert.equal(await Favorite.count({ where: { bookId: book.id } }), 2);

      await repository.update(book.id, { status: 'complete' });

      assert.equal(
        (await repository.findDetailById(book.id, null))?.favoriteCount,
        2
      );
    });
  });

  describe('search filters', () => {
    const titles = async (
      query: Omit<Parameters<typeof repository.list>[0], 'current' | 'pageSize'>
    ) =>
      (await listAsGuest({ current: 1, pageSize: 20, ...query })).items
        .map((book) => book.title)
        .sort();

    test('status keeps only the books in that status', async () => {
      const done = await publishedBook('Done');
      await repository.update(done.id, { status: 'complete' });
      await publishedBook('Ongoing');

      assert.deepEqual(await titles({ status: 'complete' }), ['Done']);
      assert.deepEqual(await titles({ status: 'in_progress' }), ['Ongoing']);
    });

    test('the release range compares the earliest published chapter, bounds inclusive, and drops a book with none', async () => {
      const early = await publishedBook('Early');
      const late = await publishedBook('Late');
      const scheduled = await publishedBook('Scheduled only');
      await publishedBook('Nothing out');
      const earlyAt = daysFromNow(-10);
      const lateAt = daysFromNow(-2);
      await addChapters(early.id, [earlyAt, daysFromNow(-1)]);
      await addChapters(late.id, [lateAt]);
      await addChapters(scheduled.id, [daysFromNow(1)]);

      assert.deepEqual(
        await titles({ releasedFrom: earlyAt, releasedTo: earlyAt }),
        ['Early']
      );
      assert.deepEqual(await titles({ releasedFrom: daysFromNow(-5) }), [
        'Late',
      ]);
      assert.deepEqual(await titles({ releasedTo: daysFromNow(-5) }), [
        'Early',
      ]);
    });

    test('the update range compares the latest published chapter, a scheduled one aside', async () => {
      const recent = await publishedBook('Recent');
      const stale = await publishedBook('Stale');
      await publishedBook('Nothing out');
      const recentAt = daysFromNow(-1);
      await addChapters(recent.id, [daysFromNow(-20), recentAt]);
      await addChapters(stale.id, [daysFromNow(-20), daysFromNow(2)]);

      assert.deepEqual(await titles({ updatedFrom: recentAt }), ['Recent']);
      assert.deepEqual(await titles({ updatedTo: daysFromNow(-10) }), [
        'Stale',
      ]);
    });

    test('author matches any co-author by login, first or last name, ignoring case', async () => {
      const coAuthorId = (await User.create({ ...coAuthor, role: 'author' }))
        .id;
      const shared = await publishedBook('Shared');
      await repository.addCoAuthor(shared.id, coAuthorId, asOwner());
      await publishedBook('Solo');

      // `login` is case-sensitive in the column; search is not.
      assert.deepEqual(await titles({ author: 'coauthor' }), ['Shared']);
      assert.deepEqual(await titles({ author: 'Cora' }), ['Shared']);
      // BookOwner / Ola Owner is credited on both.
      assert.deepEqual(await titles({ author: 'owner' }), ['Shared', 'Solo']);
      assert.deepEqual(await titles({ author: 'nobody' }), []);
    });

    test('seriesTitle matches the title of the series a book is filed in', async () => {
      await createPublished({
        userId: ownerId,
        seriesId,
        title: 'Filed',
        description: 'x',
        tags: [],
      });
      await publishedBook('Standalone');

      assert.deepEqual(await titles({ seriesTitle: 'test ser' }), ['Filed']);
      assert.deepEqual(await titles({ seriesTitle: 'Missing' }), []);
    });

    test('every filter combines with the others by AND', async () => {
      const match = await createPublished({
        userId: ownerId,
        seriesId,
        title: 'Dragon Filed',
        description: 'x',
        tags: [],
      });
      await repository.update(match.id, { status: 'complete' });
      await createPublished({
        userId: ownerId,
        seriesId,
        title: 'Dragon Ongoing',
        description: 'x',
        tags: [],
      });
      await publishedBook('Dragon Alone');

      assert.deepEqual(
        await titles({
          q: 'Dragon',
          status: 'complete',
          seriesTitle: 'Test',
          author: 'Ola',
        }),
        ['Dragon Filed']
      );
    });
  });

  test('the series filter and paging envelope agree on the total', async () => {
    for (const description of ['One', 'Two', 'Three']) {
      await createPublished({
        userId: ownerId,
        title: description,
        seriesId,
        description,
        tags: [],
      });
    }
    await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Standalone',
      tags: [],
    });

    const page = await listAsGuest({ current: 1, pageSize: 2, seriesId });

    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
  });

  test('an update replaces the whole tag array and leaves the co-authors alone', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'Original',
      tags: ['sci-fi', 'epic'],
    });

    const updated = await repository.update(created.id, { tags: ['drama'] });

    assert.deepEqual(updated?.tags, ['drama']);
    assert.deepEqual(
      updated?.authors.map((author) => author.id),
      [ownerId]
    );
    assert.equal(updated?.seriesId, seriesId);
    assert.equal(updated?.description, 'Original');
  });

  test('an update omitting tags and seriesId leaves both untouched', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'Original',
      tags: ['sci-fi'],
    });

    const updated = await repository.update(created.id, {
      description: 'Rewritten',
    });

    assert.equal(updated?.description, 'Rewritten');
    assert.deepEqual(updated?.tags, ['sci-fi']);
    assert.equal(updated?.seriesId, seriesId);
  });

  test('an explicit null seriesId unlinks the book from its series', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'Leaving the series',
      tags: [],
    });

    const updated = await repository.update(created.id, { seriesId: null });

    assert.equal(updated?.seriesId, null);
  });

  // The foreign key alone only drops the credit. Whether the book goes too is
  // userRepository.remove's decision — it deletes the books an account was the
  // last Co-author of — and is covered in userRepository.spec.ts.
  test('deleting a user row drops their credits and nothing else', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Credited',
      tags: [],
    });

    await User.destroy({ where: { id: ownerId } });

    assert.equal(await BookAuthor.count(), 0);
    assert.ok(await Book.findByPk(created.id));
  });

  test('deleting a book drops its credits', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Doomed',
      tags: [],
    });

    assert.equal(await repository.remove(created.id, asOwner()), true);
    assert.equal(await BookAuthor.count(), 0);
  });

  test('deleting the series unlinks its books instead of destroying them', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'Survivor',
      tags: [],
    });

    await Series.destroy({ where: { id: seriesId } });

    const reloaded = await repository.findById(created.id);
    assert.equal(reloaded?.description, 'Survivor');
    assert.equal(reloaded?.seriesId, null);
  });

  // --- Series order (CONTEXT.md). ---

  const fileBook = (title: string, into: number | null = seriesId) =>
    createPublished({
      userId: ownerId,
      seriesId: into,
      title,
      description: title,
      tags: [],
    });

  const seriesTitles = async (id: number = seriesId): Promise<string[]> =>
    (await listAsGuest({ current: 1, pageSize: 20, seriesId: id })).items.map(
      (book) => book.title
    );

  test('a book filed into a series is appended at the end of the Series order', async () => {
    const one = await fileBook('One');
    const two = await fileBook('Two');
    await repository.reorderInSeries(seriesId, [two.id, one.id]);

    await fileBook('Three');
    const standalone = await fileBook('Moved in', null);
    await repository.update(standalone.id, { seriesId });

    assert.deepEqual(await seriesTitles(), ['Two', 'One', 'Three', 'Moved in']);
  });

  test('a Draft book never counts toward N, and leaving the series clears the reference', async () => {
    const draft = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Hidden',
      description: '',
      tags: [],
    });
    const published = await fileBook('Shown');

    const guestView = await repository.findDetailById(published.id, null);
    assert.equal(guestView?.series?.position, 1);
    assert.equal(await repository.findDetailById(draft.id, null), null);
    const own = await repository.findDetailById(draft.id, asOwner());
    assert.equal(own?.series?.position, null);
    assert.equal(own?.series?.id, seriesId);

    const left = await repository.update(published.id, { seriesId: null });
    assert.equal(left?.series, null);
  });

  test('publishing a Draft book shifts the later Books by one, live', async () => {
    const first = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'First',
      description: '',
      tags: [],
    });
    const second = await fileBook('Second');
    assert.equal(
      (await repository.findDetailById(second.id, null))?.series?.position,
      1
    );

    await repository.update(first.id, { status: 'in_progress' });
    assert.equal(
      (await repository.findDetailById(first.id, null))?.series?.position,
      1
    );
    assert.equal(
      (await repository.findDetailById(second.id, null))?.series?.position,
      2
    );
  });

  test('the list and the detail embed the same series reference', async () => {
    const book = await fileBook('Same');
    const listed = (await listAsGuest({ current: 1, pageSize: 20, seriesId }))
      .items;
    const detail = await repository.findDetailById(book.id, null);
    assert.deepEqual(
      listed.find((item) => item.id === book.id)?.series,
      detail?.series
    );
  });

  test('a book keeps its place when saved into the same series, and is appended when moved to another', async () => {
    const other = await createCreditedSeries(
      { title: 'Other', description: 'x', tags: [] },
      [ownerId]
    );
    const one = await fileBook('One');
    const two = await fileBook('Two');
    await fileBook('Elsewhere', other.id);

    // Appending it again would put One after Two.
    await repository.update(one.id, { seriesId, description: 'Resaved' });
    assert.deepEqual(await seriesTitles(), ['One', 'Two']);

    await repository.update(one.id, { seriesId: other.id });
    assert.deepEqual(await seriesTitles(other.id), ['Elsewhere', 'One']);
    assert.deepEqual(await seriesTitles(), ['Two']);

    await repository.update(two.id, { seriesId: null });
    assert.equal((await Book.findByPk(two.id))?.seriesPosition, null);
  });

  test('books filed into a series at the same moment still get a place each', async () => {
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((title) => fileBook(title))
    );

    const positions = (
      await Book.findAll({
        where: { seriesId },
        attributes: ['seriesPosition'],
      })
    ).map((book) => book.seriesPosition);
    assert.equal(new Set(positions).size, 5);
  });

  test('a book moving in and out of a series while it is reordered never deadlocks', async () => {
    const one = await fileBook('One');
    const two = await fileBook('Two');
    const mover = await fileBook('Mover', null);

    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.allSettled([
        repository.update(mover.id, { seriesId }),
        repository.reorderInSeries(seriesId, [two.id, one.id]),
      ]);
      assertNoDbError(results);
      assertNoDbError(
        await Promise.allSettled([
          repository.update(mover.id, { seriesId: null }),
          repository.reorderInSeries(seriesId, [one.id, two.id]),
        ])
      );
    }
  });

  test('a book update names a missing target series before anything else is written', async () => {
    const book = await fileBook('Solo', null);
    await assert.rejects(
      repository.update(book.id, { title: 'Renamed', seriesId: 999_999 }),
      new NotFoundError('Series', 999_999)
    );
    assert.equal((await Book.findByPk(book.id))?.title, 'Solo');
  });

  test('a series reorder rewrites the order its lists follow, and the editor list keeps its drafts', async () => {
    const one = await fileBook('One');
    const draft = await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Draft',
      description: 'Not out',
      tags: [],
    });
    const three = await fileBook('Three');

    assert.equal(
      await repository.reorderInSeries(seriesId, [three.id, draft.id, one.id]),
      true
    );

    assert.deepEqual(await seriesTitles(), ['Three', 'One']);
    const editorList = await repository.listInSeries(seriesId);
    assert.deepEqual(
      editorList?.map((book) => [book.title, book.status]),
      [
        ['Three', 'in_progress'],
        ['Draft', 'draft'],
        ['One', 'in_progress'],
      ]
    );
    // A summary: the draft's title and status, never its text.
    assert.deepEqual(Object.keys(editorList?.[1] ?? {}).sort(), [
      'authors',
      'id',
      'status',
      'title',
    ]);
    assert.deepEqual(
      editorList?.[0]?.authors.map((author) => author.id),
      [ownerId]
    );
  });

  test('a series reorder leaves every book version alone', async () => {
    const one = await fileBook('One');
    const two = await fileBook('Two');
    const before = (await Book.findByPk(one.id))?.updatedAt.getTime();

    await repository.reorderInSeries(seriesId, [two.id, one.id]);

    assert.equal((await Book.findByPk(one.id))?.updatedAt.getTime(), before);
  });

  test('a series reorder that does not name exactly the books in the series is a conflict and changes nothing', async () => {
    const one = await fileBook('One');
    const two = await fileBook('Two');
    const standalone = await fileBook('Standalone', null);

    for (const bookIds of [
      [two.id],
      [two.id, one.id, one.id + 10_000],
      [two.id, standalone.id],
    ]) {
      await assert.rejects(
        repository.reorderInSeries(seriesId, bookIds),
        (error: unknown) => error instanceof StateConflictError,
        JSON.stringify(bookIds)
      );
    }

    assert.deepEqual(await seriesTitles(), ['One', 'Two']);
  });

  test('a missing series has no books to list or reorder', async () => {
    assert.equal(await repository.listInSeries(seriesId + 10_000), null);
    assert.equal(
      await repository.reorderInSeries(seriesId + 10_000, [1]),
      false
    );
  });

  test('a series eager-loads its books under the `books` alias', async () => {
    await repository.create({
      userId: ownerId,
      seriesId,
      title: 'Test Book',
      description: 'A',
      tags: [],
    });
    await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'B',
      tags: [],
    });

    const loadedSeries = await Series.findByPk(seriesId, {
      include: { association: 'books' },
    });

    assert.equal(loadedSeries?.books?.length, 1);
  });

  // --- Cover storage. ---

  test('a cover round-trips through setCover/getCoverData, and a second upload replaces the first', async () => {
    // Published, not a fresh draft: this test is about the round-trip, not
    // about who may read a draft's cover — that is the next test's job, and a
    // guest reading a draft's cover would fail for the wrong reason.
    const created = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Has a cover',
      tags: [],
    });
    const guest: Viewer = null;

    assert.equal(await repository.getCoverData(created.id, guest), null);

    const first = Buffer.from('first-cover-bytes');
    assert.equal(await repository.setCover(created.id, first), true);
    const stored = await repository.getCoverData(created.id, guest);
    assert.deepEqual(stored?.data, first);

    // A gap between the two uploads, as the route specs wait between theirs:
    // cache-busting depends on ?v= changing, so the second updatedAt must be
    // strictly later, not merely no earlier — `>=` would pass even if the
    // column never moved.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = Buffer.from('second-cover-bytes, longer than the first');
    assert.equal(await repository.setCover(created.id, second), true);
    const replaced = await repository.getCoverData(created.id, guest);
    assert.deepEqual(replaced?.data, second);
    assert.ok(
      (replaced?.updatedAt.getTime() ?? 0) > (stored?.updatedAt.getTime() ?? 0)
    );
  });

  test('setCover and removeCover on a missing book report it, and removing a cover that never existed is a no-op', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'No cover yet',
      tags: [],
    });
    const missingId = ownerId + 10_000;

    assert.equal(await repository.setCover(missingId, Buffer.from('x')), false);
    assert.equal(await repository.removeCover(missingId), false);
    assert.equal(await repository.removeCover(created.id), true);
    assert.equal(await repository.getCoverData(created.id, null), null);
  });

  test('setCover answers false when the book vanishes between the lookup and the write, and rethrows other errors', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Racy',
      description: '',
      tags: [],
    });
    const missingId = created.id + 10_000;

    assert.equal(await repository.setCover(missingId, Buffer.from('x')), false);

    const broken = mock.method(BookCover, 'upsert', async () => {
      throw new Error('disk full');
    });
    try {
      await assert.rejects(
        repository.setCover(created.id, Buffer.from('x')),
        /disk full/
      );
    } finally {
      broken.mock.restore();
    }
  });

  test('a draft book cover is unreadable to a guest and a non-co-author, readable to a co-author and a moderator', async () => {
    const draft = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Draft',
      description: 'Private',
      tags: [],
    });
    await repository.setCover(draft.id, Buffer.from('draft-cover'));
    const stranger = ownerId + 10_000;

    assert.equal(await repository.getCoverData(draft.id, null), null);
    assert.equal(
      await repository.getCoverData(draft.id, { id: stranger, role: 'user' }),
      null
    );
    assert.ok(
      await repository.getCoverData(draft.id, { id: ownerId, role: 'author' })
    );
    assert.ok(
      await repository.getCoverData(draft.id, { id: stranger, role: 'admin' })
    );
  });

  test('deleting a book takes its cover with it', async () => {
    const created = await repository.create({
      userId: ownerId,
      seriesId: null,
      title: 'Test Book',
      description: 'Doomed',
      tags: [],
    });
    await repository.setCover(created.id, Buffer.from('gone-soon'));

    await repository.remove(created.id, asOwner());

    // A fresh row would answer null through getCoverData too, but a direct
    // model read is what actually proves the cascade rather than merely a
    // missing book.
    assert.equal(await BookCover.findByPk(created.id), null);
  });

  test('a list read returns the version without the bytes', async () => {
    const withCover = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'Has A Cover',
      description: 'B',
      tags: [],
    });
    const withoutCover = await createPublished({
      userId: ownerId,
      seriesId: null,
      title: 'No Cover',
      description: 'B',
      tags: [],
    });
    await repository.setCover(withCover.id, Buffer.from('list-cover-bytes'));

    const { items } = await listAsGuest({ current: 1, pageSize: 20 });

    const withCoverItem = items.find((item) => item.id === withCover.id);
    const withoutCoverItem = items.find((item) => item.id === withoutCover.id);
    assert.match(
      withCoverItem?.coverUrl ?? '',
      new RegExp(`^/api/books/${withCover.id}/cover\\?v=\\d+$`)
    );
    assert.ok(withCoverItem && !('data' in withCoverItem));
    assert.equal(withoutCoverItem?.coverUrl, null);
  });

  // --- The contract the route specs' fake is held to, run here for real. ---

  let contractAccounts = 0;
  let contractGenres = 0;
  bookRepositoryContract(async () => ({
    repository,
    async anAuthor() {
      contractAccounts += 1;
      const user = await User.create({
        ...coAuthor,
        login: `ContractAuthor${contractAccounts}`,
        email: `contract-author-${contractAccounts}@example.com`,
        role: 'author',
      });
      return user.id;
    },
    async aSeries(coAuthorIds) {
      const series = await createCreditedSeries(
        { title: 'Contract Series', description: 'x', tags: [] },
        coAuthorIds
      );
      return series.id;
    },
    async aGenre() {
      contractGenres += 1;
      const genre = await Genre.create({
        name: `Contract Genre ${contractGenres}`,
      });
      return genre.id;
    },
  }));
});
