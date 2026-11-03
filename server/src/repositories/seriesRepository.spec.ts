process.env.NODE_ENV ??= 'test';

import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatabaseError,
  ForeignKeyConstraintError,
  Op,
  type Sequelize,
} from 'sequelize';
import { createSequelize } from '../db/sequelize.ts';
import { ensureDatabase } from '../db/ensureDatabase.ts';
import { testDbConfig } from '../db/testDb.testkit.ts';
import { skipWithoutMysql } from '../db/mysqlProbe.testkit.ts';
import { initModels } from '../models/index.ts';
import { Book } from '../models/Book.ts';
import { Chapter } from '../models/Chapter.ts';
import { Favorite } from '../models/Favorite.ts';
import { destroyAllGenres, Genre } from '../models/Genre.ts';
import { LibraryEntry } from '../models/LibraryEntry.ts';
import { Like } from '../models/Like.ts';
import { Series } from '../models/Series.ts';
import { SeriesCover } from '../models/SeriesCover.ts';
import { SeriesAuthor } from '../models/SeriesAuthor.ts';
import { User } from '../models/User.ts';
import {
  createCreditedBook,
  createCreditedSeries,
} from '../models/creditedBook.testkit.ts';
import {
  AppError,
  NotFoundError,
  StateConflictError,
} from '../types/errors.ts';
import { createSequelizeSeriesRepository } from './seriesRepository.ts';
import { seriesRepositoryContract } from './seriesRepository.contract.testkit.ts';
import type { Viewer } from './visibility.ts';
import type { PublicSeries, WithFavoriteId } from 'shared';

const skip = await skipWithoutMysql();

const owner = {
  login: 'SeriesOwner',
  email: 'owner@example.com',
  password: 'hunter2hunter2',
  firstName: 'Ola',
  lastName: 'Owner',
  status: 'active' as const,
};

const coAuthor = {
  login: 'SeriesCoAuthor',
  email: 'series-coauthor@example.com',
  password: 'hunter2hunter2',
  firstName: 'Cora',
  lastName: 'Author',
};

describe('seriesRepository against real MySQL', { skip }, () => {
  let sequelize: Sequelize;
  let ownerId: number;
  // Who acts in the calls below. The rules on who may act are the
  // controllers'; this suite is about what each change does.
  const asOwner = () => ({ id: ownerId, role: 'author' as const });
  const repository = createSequelizeSeriesRepository();
  // Most series here hold no book at all, which hides them from a reader. The
  // tests that are not about visibility read as a Moderator, who sees every
  // series.
  const asModerator: Viewer = { id: 0, role: 'superadmin' };

  before(async () => {
    const db = testDbConfig('series');
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
    // them. Books are cleared by hand, since a series only unlinks its books.
    await Book.destroy({ where: {}, truncate: false });
    await Series.destroy({ where: {}, truncate: false });
    await destroyAllGenres();
    await User.destroy({ where: {}, truncate: false });
    ownerId = (await User.create(owner)).id;
  });

  test('creating a series credits its creator as its only co-author', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Solo',
      tags: [],
    });

    const expected = [
      {
        id: ownerId,
        login: 'SeriesOwner',
        firstName: 'Ola',
        lastName: 'Owner',
        status: 'active',
        avatarUrl: null,
      },
    ];
    assert.deepEqual(created.authors, expected);
    assert.deepEqual(
      (await repository.findById(created.id, asModerator))?.authors,
      expected
    );
  });

  test('a co-author is credited after the ones already there', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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
      ['SeriesOwner', 'SeriesCoAuthor']
    );
  });

  test('only an account holding the author role can be made a co-author', async () => {
    const readerId = (await User.create({ ...coAuthor, role: 'user' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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
    assert.equal(
      (await repository.findById(created.id, asModerator))?.authors.length,
      1
    );
  });

  test('crediting an account that does not exist blames the user', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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
      title: 'Test Series',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(created.id, coAuthorId, asOwner());

    await assert.rejects(
      repository.addCoAuthor(created.id, coAuthorId, asOwner()),
      (error: unknown) => error instanceof AppError && error.statusCode === 409
    );
  });

  test('removing a co-author leaves the rest credited', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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
      title: 'Test Series',
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
    assert.equal(
      (await repository.findById(created.id, asModerator))?.authors.length,
      1
    );
  });

  test('removing an account that is not credited is a 404, even on a solo series', async () => {
    const strangerId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Solo',
      tags: [],
    });

    await assert.rejects(
      repository.removeCoAuthor(created.id, strangerId, asOwner()),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Co-author \d+ not found/.test(error.message)
    );
  });

  // What every `own` check on a series asks (coAuthorGuard).
  test('findCoAuthorIds lists the co-authors in credit order, and null for a missing series', async () => {
    const earlierId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const laterId = (
      await User.create({
        ...coAuthor,
        login: 'LaterSeriesAuthor',
        email: 'later-series@example.com',
        role: 'author',
      })
    ).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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

  // As on a book: only the unique index's rejection is a 409. An account
  // deleted between the lookup and the insert fails the foreign key, and that
  // is answered as 404 on the user.
  test('an account deleted between the lookup and the insert is a missing user, not a conflict', async () => {
    const doomedId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Shared',
      tags: [],
    });

    SeriesAuthor.addHook('beforeCreate', 'deleteAccount', async () => {
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
      SeriesAuthor.removeHook('beforeCreate', 'deleteAccount');
    }
    assert.deepEqual(await repository.findCoAuthorIds(created.id), [ownerId]);
  });

  test('two co-authors of a two-author series leaving at once: one leaves, one gets a conflict', async () => {
    const otherId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
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

  test('crediting a co-author while the series is deleted never fails unmapped', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Shared',
      tags: [],
    });

    const [added] = await Promise.allSettled([
      repository.addCoAuthor(created.id, coAuthorId, asOwner()),
      repository.remove(created.id, asOwner()),
    ]);

    assert.equal(added.status, 'fulfilled'); // the series, or null once it is gone
  });

  // Only a rejected foreign key means a missing user; anything else the
  // database refuses is passed on as it is.
  test('a create the database refuses for another reason is not blamed on the user', async () => {
    await assert.rejects(
      repository.create({
        userId: ownerId,
        title: 'x'.repeat(256),
        description: 'Too long a title for its column',
        tags: [],
      }),
      (error: unknown) =>
        error instanceof DatabaseError &&
        !(error instanceof ForeignKeyConstraintError)
    );
  });

  test('the userId filter matches a series through any of its co-authors', async () => {
    const coAuthorId = (await User.create({ ...coAuthor, role: 'author' })).id;
    const shared = await repository.create({
      userId: ownerId,
      title: 'Shared Series',
      description: 'Shared',
      tags: [],
    });
    await repository.addCoAuthor(shared.id, coAuthorId, asOwner());
    await repository.create({
      userId: ownerId,
      title: 'Solo Series',
      description: 'Solo',
      tags: [],
    });

    const page = await repository.list(
      {
        limit: 20,
        offset: 0,
        userId: coAuthorId,
      },
      asModerator
    );

    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.title, 'Shared Series');
  });

  test('bookCount counts only Published books, on list, detail and findById', async () => {
    const series = await repository.create({
      userId: ownerId,
      title: 'Counted',
      description: '',
      tags: [],
    });
    const filed = (status: 'in_progress' | 'complete' | 'draft') =>
      createCreditedBook(
        {
          title: status,
          description: '',
          tags: [],
          seriesId: series.id,
          status,
        },
        [ownerId]
      );
    await filed('in_progress');
    await filed('complete');
    await filed('draft');

    assert.equal(
      (await repository.findById(series.id, asModerator))?.bookCount,
      2
    );
    assert.equal(
      (await repository.findDetailById(series.id, asModerator))?.bookCount,
      2
    );
    const listed = await repository.list({ limit: 10, offset: 0 }, asModerator);
    assert.equal(
      listed.items.find((item) => item.id === series.id)?.bookCount,
      2
    );
  });

  test('coverUrl is versioned by the Cover row and gone with it; deleting the series cascades', async () => {
    const series = await repository.create({
      userId: ownerId,
      title: 'Covered',
      description: '',
      tags: [],
    });
    await SeriesCover.create({ seriesId: series.id, data: Buffer.from('x') });

    const found = await repository.findById(series.id, asModerator);
    assert.match(
      found?.coverUrl ?? '',
      new RegExp(`^/api/series/${series.id}/cover\\?v=\\d+$`)
    );

    assert.equal(await repository.remove(series.id, asOwner()), true);
    assert.equal(await SeriesCover.findByPk(series.id), null);
  });

  test('a second upload replaces the Cover and moves its version', async () => {
    const series = await repository.create({
      userId: ownerId,
      title: 'Replaced',
      description: '',
      tags: [],
    });
    await repository.setCover(series.id, Buffer.from('first'));
    const first = await repository.getCoverData(series.id, asModerator);
    const firstUrl = (await repository.findById(series.id, asModerator))
      ?.coverUrl;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await repository.setCover(series.id, Buffer.from('second, longer'));
    const second = await repository.getCoverData(series.id, asModerator);

    assert.deepEqual(second?.data, Buffer.from('second, longer'));
    assert.ok(
      (second?.updatedAt.getTime() ?? 0) > (first?.updatedAt.getTime() ?? 0)
    );
    assert.notEqual(
      (await repository.findById(series.id, asModerator))?.coverUrl,
      firstUrl
    );
  });

  test('setCover answers false when the series vanishes between the lookup and the write, and rethrows other errors', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Racy',
      description: '',
      tags: [],
    });
    const missingId = created.id + 10_000;

    assert.equal(await repository.setCover(missingId, Buffer.from('x')), false);

    const broken = mock.method(SeriesCover, 'upsert', async () => {
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

  test('a Draft-only series Cover is hidden from a guest, readable to a Co-author and a Moderator', async () => {
    const series = await repository.create({
      userId: ownerId,
      title: 'Hidden',
      description: '',
      tags: [],
    });
    await createCreditedBook(
      {
        title: 'D',
        description: '',
        tags: [],
        seriesId: series.id,
        status: 'draft',
      },
      [ownerId]
    );
    await repository.setCover(series.id, Buffer.from('c'));

    assert.equal(await repository.getCoverData(series.id, null), null);
    assert.ok(
      await repository.getCoverData(series.id, { id: ownerId, role: 'author' })
    );
    assert.ok(await repository.getCoverData(series.id, asModerator));

    await createCreditedBook(
      {
        title: 'P',
        description: '',
        tags: [],
        seriesId: series.id,
        status: 'in_progress',
      },
      [ownerId]
    );
    assert.ok(await repository.getCoverData(series.id, null));
  });

  test('removing a book from a series unlinks it and leaves the book standing', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Holds a book',
      tags: [],
    });
    const filed = await createCreditedBook(
      {
        title: 'Filed',
        description: 'In the series',
        tags: [],
        seriesId: created.id,
      },
      [ownerId]
    );
    // Book.update ignores an explicit updatedAt, and a Date replacement skews
    // by the session time zone, so backdate a year in SQL.
    await sequelize.query(
      'UPDATE books SET updatedAt = updatedAt - INTERVAL 1 YEAR WHERE id = ?',
      { replacements: [filed.id] }
    );
    const past = (await Book.findByPk(filed.id))?.updatedAt;
    assert.ok(past && past.getTime() < Date.now() - 300 * 24 * 3600 * 1000);

    assert.equal(await repository.removeBook(created.id, filed.id), true);

    const reloaded = await Book.findByPk(filed.id);
    assert.equal(reloaded?.seriesId, null);
    // Out of the series, out of its order: filing it again appends it afresh.
    assert.equal(reloaded?.seriesPosition, null);
    assert.equal(reloaded?.updatedAt.getTime(), past.getTime());
  });

  test('removing a book that is not in the series is a 404 on the book', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Empty',
      tags: [],
    });
    const standalone = await createCreditedBook(
      { title: 'Standalone', description: 'In no series', tags: [] },
      [ownerId]
    );

    await assert.rejects(
      repository.removeBook(created.id, standalone.id),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Book \d+ not found/.test(error.message)
    );
    assert.equal(
      await repository.removeBook(created.id + 10_000, standalone.id),
      false
    );
  });

  test('round-trips tags through the JSON column as a real array', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'A space opera',
      tags: ['sci-fi', 'epic'],
    });

    const reloaded = await repository.findById(created.id, asModerator);

    assert.ok(Array.isArray(reloaded?.tags));
    assert.deepEqual(reloaded?.tags, ['sci-fi', 'epic']);
  });

  test('stores an empty tag list without a DDL default', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'No tags',
      tags: [],
    });

    assert.deepEqual(
      (await repository.findById(created.id, asModerator))?.tags,
      []
    );
  });

  test('tags survive multi-byte characters, thanks to utf8mb4', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Epic 📚',
      tags: ['sci-fi', '📚'],
    });

    const reloaded = await repository.findById(created.id, asModerator);

    assert.equal(reloaded?.description, 'Epic 📚');
    assert.deepEqual(reloaded?.tags, ['sci-fi', '📚']);
  });

  test('a create against an unknown user surfaces as NotFoundError, not a raw FK error', async () => {
    await assert.rejects(
      repository.create({
        userId: ownerId + 10_000,
        title: 'Test Series',
        description: 'Orphan',
        tags: [],
      }),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /User \d+ not found/.test(error.message)
    );
  });

  test('the tag filter matches through JSON_CONTAINS, not a substring', async () => {
    await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Tagged epic',
      tags: ['epic'],
    });
    await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Tagged epic-fantasy',
      tags: ['epic-fantasy'],
    });

    const exact = await repository.list(
      { limit: 20, offset: 0, tag: 'epic' },
      asModerator
    );

    // A LIKE-based implementation would return both rows here.
    assert.equal(exact.total, 1);
    assert.equal(exact.items[0]?.description, 'Tagged epic');
  });

  test('the description search treats LIKE metacharacters literally', async () => {
    await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Contains a 100% real percent sign',
      tags: [],
    });
    await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'No metacharacter here',
      tags: [],
    });

    const matches = await repository.list(
      { limit: 20, offset: 0, q: '%' },
      asModerator
    );

    assert.equal(matches.total, 1);
    assert.match(matches.items[0]?.description ?? '', /100% real/);
  });

  test('the genre filter returns that genre alone, and an unknown id returns nothing', async () => {
    const gothic = await Genre.create({ name: 'Filter Gothic' });
    const filed = await repository.create({
      userId: ownerId,
      title: 'In Gothic',
      description: 'A',
      tags: [],
      genreId: gothic.id,
    });
    await repository.create({
      userId: ownerId,
      title: 'No Genre',
      description: 'B',
      tags: [],
    });

    const inGothic = await repository.list(
      { limit: 20, offset: 0, genreId: gothic.id },
      asModerator
    );
    const inMissing = await repository.list(
      { limit: 20, offset: 0, genreId: 999_999 },
      asModerator
    );

    assert.deepEqual(
      inGothic.items.map((item) => item.id),
      [filed.id]
    );
    assert.equal(inGothic.items[0]?.genre?.name, 'Filter Gothic');
    assert.equal(inMissing.total, 0);
  });

  test('the genre filter on a top-level Genre also returns its Subgenres’ series; a Subgenre matches only itself', async () => {
    const fantasy = await Genre.create({ name: 'Family Fantasy' });
    const urban = await Genre.create({
      name: 'Family Urban',
      parentId: fantasy.id,
    });
    const horror = await Genre.create({ name: 'Family Horror' });
    const make = (title: string, genreId: number) =>
      repository.create({
        userId: ownerId,
        title,
        description: 'x',
        tags: [],
        genreId,
      });
    const top = await make('Top', fantasy.id);
    const sub = await make('Sub', urban.id);
    await make('Elsewhere', horror.id);

    const byTop = await repository.list(
      { limit: 20, offset: 0, genreId: fantasy.id },
      asModerator
    );
    const bySub = await repository.list(
      { limit: 20, offset: 0, genreId: urban.id },
      asModerator
    );

    assert.deepEqual(
      byTop.items.map((item) => item.id).sort(),
      [top.id, sub.id].sort()
    );
    assert.deepEqual(
      bySub.items.map((item) => item.id),
      [sub.id]
    );
  });

  test('the co-author filter and paging envelope agree on the total', async () => {
    const otherId = (
      await User.create({
        ...owner,
        login: 'OtherOwner',
        email: 'other@example.com',
      })
    ).id;

    for (const description of ['One', 'Two', 'Three']) {
      await repository.create({
        userId: ownerId,
        title: description,
        description,
        tags: [],
      });
    }
    await repository.create({
      userId: otherId,
      title: 'Theirs',
      description: 'Theirs',
      tags: [],
    });

    const page = await repository.list(
      {
        limit: 2,
        offset: 0,
        userId: ownerId,
      },
      asModerator
    );

    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
  });

  test('an update replaces the whole tag array and leaves the co-authors alone', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Original',
      tags: ['sci-fi', 'epic'],
    });

    const updated = await repository.update(created.id, { tags: ['drama'] });

    assert.deepEqual(updated?.tags, ['drama']);
    assert.deepEqual(
      updated?.authors.map((author) => author.id),
      [ownerId]
    );
    assert.equal(updated?.description, 'Original');
  });

  test('an update omitting tags leaves the stored ones untouched', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Original',
      tags: ['sci-fi'],
    });

    const updated = await repository.update(created.id, {
      description: 'Rewritten',
    });

    assert.equal(updated?.description, 'Rewritten');
    assert.deepEqual(updated?.tags, ['sci-fi']);
  });

  // The foreign key alone only drops the credit. Whether the series goes too is
  // userRepository.remove's decision, covered in userRepository.spec.ts.
  test('deleting a user row drops their credits and nothing else', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Credited',
      tags: [],
    });

    await User.destroy({ where: { id: ownerId } });

    assert.equal(await SeriesAuthor.count(), 0);
    assert.ok(await Series.findByPk(created.id));
  });

  test('deleting a series drops its credits', async () => {
    const created = await repository.create({
      userId: ownerId,
      title: 'Test Series',
      description: 'Doomed',
      tags: [],
    });

    assert.equal(await repository.remove(created.id, asOwner()), true);
    assert.equal(await SeriesAuthor.count(), 0);
  });

  test('a series with no published book is visible only to its co-authors and moderators', async () => {
    const empty = await repository.create({
      userId: ownerId,
      title: 'Empty',
      description: 'Nothing yet',
      tags: [],
    });
    const drafted = await repository.create({
      userId: ownerId,
      title: 'Drafted',
      description: 'Only drafts',
      tags: [],
    });
    await createCreditedBook(
      {
        title: 'Draft',
        description: 'Private',
        tags: [],
        seriesId: drafted.id,
        status: 'draft',
      },
      [ownerId]
    );
    const out = await repository.create({
      userId: ownerId,
      title: 'Out',
      description: 'Has a published book',
      tags: [],
    });
    await createCreditedBook(
      {
        title: 'Published',
        description: 'Public',
        tags: [],
        seriesId: out.id,
        status: 'complete',
      },
      [ownerId]
    );
    const stranger = ownerId + 1_000;

    const titles = async (viewer: Viewer): Promise<string[]> =>
      (await repository.list({ limit: 20, offset: 0 }, viewer)).items.map(
        (series) => series.title
      );

    for (const viewer of [
      null,
      { id: stranger, role: 'user' },
      { id: stranger, role: 'author' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Out']);
      assert.equal(await repository.findById(empty.id, viewer), null);
      assert.equal(await repository.findById(drafted.id, viewer), null);
    }

    for (const viewer of [
      { id: ownerId, role: 'author' },
      { id: stranger, role: 'admin' },
      { id: stranger, role: 'superadmin' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Empty', 'Drafted', 'Out']);
      assert.equal((await repository.findById(empty.id, viewer))?.id, empty.id);
    }
  });

  describe('detail', () => {
    let fanCount = 0;
    const aFan = async () => {
      fanCount += 1;
      return User.create({
        login: `SeriesFan${fanCount}`,
        email: `series-fan-${fanCount}@example.com`,
        password: 'hunter2hunter2',
        firstName: 'Series',
        lastName: `Fan${fanCount}`,
      });
    };

    const aPublishedSeries = async (
      title: string,
      extra: { tags?: string[]; genreId?: number } = {}
    ) => {
      const series = await repository.create({
        userId: ownerId,
        title,
        description: title,
        tags: [],
        ...extra,
      });
      await createCreditedBook(
        {
          title: `${title} Book`,
          description: 'x',
          tags: [],
          seriesId: series.id,
        },
        [ownerId]
      );
      return series;
    };

    test("favoriteCount counts every holder, and viewerFavoriteId names the viewer's own", async () => {
      const series = await aPublishedSeries('Treasured Saga');
      const elsewhere = await aPublishedSeries('Other Saga');
      const fan = await aFan();
      const otherFan = await aFan();
      const own = await Favorite.create({
        userId: fan.id,
        seriesId: series.id,
      });
      await Favorite.create({ userId: otherFan.id, seriesId: series.id });
      await Favorite.create({ userId: fan.id, seriesId: elsewhere.id });

      const asFan = await repository.findDetailById(series.id, {
        id: fan.id,
        role: 'user',
      });
      const asGuest = await repository.findDetailById(series.id, null);

      assert.deepEqual(
        [asFan?.favoriteCount, asFan?.viewerFavoriteId],
        [2, own.id]
      );
      assert.deepEqual(
        [asGuest?.favoriteCount, asGuest?.viewerFavoriteId],
        [2, null]
      );
      assert.deepEqual(
        asGuest?.authors.map((author) => author.id),
        [ownerId]
      );
    });

    test('viewerLibrary reflects the viewer entries and is null for a Guest', async () => {
      const series = await aPublishedSeries('Shelved Saga');
      const reader = await aFan();
      const second = await createCreditedBook(
        { title: 'Second', description: 'x', tags: [], seriesId: series.id },
        [ownerId]
      );
      const detailFor = async () =>
        (
          await repository.findDetailById(series.id, {
            id: reader.id,
            role: 'user',
          })
        )?.viewerLibrary;
      const none = { inLibrary: false, notInterested: false };
      assert.deepEqual(await detailFor(), none);

      const first = await Book.findOne({
        where: { seriesId: series.id, id: { [Op.ne]: second.id } },
      });
      await LibraryEntry.create({
        userId: reader.id,
        bookId: second.id,
        status: 'not_interested',
      });
      assert.deepEqual(await detailFor(), none);
      await LibraryEntry.create({
        userId: reader.id,
        bookId: first!.id,
        status: 'not_interested',
      });
      assert.deepEqual(await detailFor(), {
        inLibrary: false,
        notInterested: true,
      });
      await LibraryEntry.update(
        { status: 'reading' },
        { where: { userId: reader.id, bookId: first!.id } }
      );
      assert.deepEqual(await detailFor(), {
        inLibrary: true,
        notInterested: false,
      });
      assert.equal(
        (await repository.findDetailById(series.id, null))?.viewerLibrary,
        null
      );
    });

    const favoriteQuery = { limit: 20, offset: 0, favoritedBy: 'me' } as const;

    test('favoritedBy=me lists only the viewer own favorited series, each with its favoriteId', async () => {
      const mine = await aPublishedSeries('Mine');
      const theirs = await aPublishedSeries('Theirs');
      await aPublishedSeries('Nobody');
      const fan = await aFan();
      const other = await aFan();
      const row = await Favorite.create({ userId: fan.id, seriesId: mine.id });
      await Favorite.create({ userId: other.id, seriesId: theirs.id });
      await Favorite.create({ userId: other.id, seriesId: mine.id });

      const page = await repository.list(favoriteQuery, {
        id: fan.id,
        role: 'user',
      });

      assert.deepEqual(
        page.items.map((item) => item.id),
        [mine.id]
      );
      assert.equal(page.total, 1);
      assert.equal(
        (page.items[0] as WithFavoriteId<PublicSeries>).favoriteId,
        row.id
      );
    });

    test('favoritedBy=me matches nothing for a viewer with no Favorites, and for no viewer', async () => {
      await aPublishedSeries('Unloved');
      const fan = await aFan();

      const none = await repository.list(favoriteQuery, {
        id: fan.id,
        role: 'user',
      });
      const guest = await repository.list(favoriteQuery, null);

      assert.deepEqual([none.total, guest.total], [0, 0]);
    });

    test('favoritedBy=me combines by AND with q, tag, genreId and paging', async () => {
      const genre = await Genre.create({ name: 'Favorite Series Genre' });
      const saga = await aPublishedSeries('Dragon Saga', {
        tags: ['epic'],
        genreId: genre.id,
      });
      const tales = await aPublishedSeries('Dragon Tales');
      const hills = await aPublishedSeries('Quiet Hills', {
        genreId: genre.id,
      });
      await aPublishedSeries('Dragon Lore', {
        tags: ['epic'],
        genreId: genre.id,
      });
      const fan = await aFan();
      const viewer = { id: fan.id, role: 'user' } as const;
      for (const series of [saga, tales, hills]) {
        await Favorite.create({ userId: fan.id, seriesId: series.id });
      }

      const byText = await repository.list(
        { ...favoriteQuery, q: 'Dragon' },
        viewer
      );
      const byTag = await repository.list(
        { ...favoriteQuery, q: 'Dragon', tag: 'epic' },
        viewer
      );
      const byGenre = await repository.list(
        { ...favoriteQuery, q: 'Dragon', genreId: genre.id },
        viewer
      );
      const paged = await repository.list(
        { ...favoriteQuery, q: 'Dragon', limit: 1 },
        viewer
      );

      assert.deepEqual(
        byText.items.map((item) => item.id).sort(),
        [saga.id, tales.id].sort()
      );
      assert.deepEqual(
        byTag.items.map((item) => item.id),
        [saga.id]
      );
      assert.deepEqual(
        byGenre.items.map((item) => item.id),
        [saga.id]
      );
      assert.deepEqual([paged.total, paged.items.length], [2, 1]);
    });

    test('a series the viewer may not see has no detail, as findById has no record', async () => {
      const hidden = await repository.create({
        userId: ownerId,
        title: 'Nothing Out',
        description: 'x',
        tags: [],
      });

      assert.equal(await repository.findDetailById(hidden.id, null), null);
      assert.equal(
        (await repository.findDetailById(hidden.id, asOwner()))?.id,
        hidden.id
      );
    });
  });

  describe('published and sorted lists', () => {
    const makeSeries = (title: string) =>
      createCreditedSeries({ title, description: title, tags: [] }, [ownerId]);
    const fileBook = (
      seriesId: number,
      status: 'in_progress' | 'draft' = 'in_progress'
    ) =>
      createCreditedBook(
        { title: 'Filed', description: 'd', tags: [], seriesId, status },
        [ownerId]
      );
    const page = (
      query: Partial<Parameters<typeof repository.list>[0]>,
      viewer: Viewer = null
    ) => repository.list({ limit: 20, offset: 0, ...query }, viewer);

    test('published=true lists only Series holding a Published Book, for every viewer', async () => {
      const live = await makeSeries('Live');
      await fileBook(live.id);
      const draftOnly = await makeSeries('Draft only');
      await fileBook(draftOnly.id, 'draft');
      await makeSeries('Empty');
      const titles = async (viewer: Viewer, published?: 'true') =>
        (await page({ userId: ownerId, published }, viewer)).items
          .map((series) => series.title)
          .sort();

      assert.deepEqual(await titles(asOwner()), [
        'Draft only',
        'Empty',
        'Live',
      ]);
      for (const viewer of [asOwner(), asModerator, null]) {
        assert.deepEqual(await titles(viewer, 'true'), ['Live']);
      }
      assert.equal(
        (await page({ userId: ownerId, published: 'true' }, asOwner())).total,
        1
      );
    });

    test('published=true on an Account with no Series is an empty page, not an error', async () => {
      assert.deepEqual(await page({ userId: ownerId, published: 'true' }), {
        items: [],
        total: 0,
      });
    });

    const DAY = 24 * 60 * 60 * 1000;
    const daysFromNow = (days: number) => new Date(Date.now() + days * DAY);
    let readers = 0;

    const chapters = (bookId: number, at: (Date | null)[]) =>
      Chapter.bulkCreate(
        at.map((publishedAt, index) => ({
          bookId,
          title: `Chapter ${index + 1}`,
          text: 'text',
          publishedAt,
          position: index + 1,
        }))
      );
    const react = async (bookId: number, isLikes: boolean[]) => {
      for (const isLike of isLikes) {
        readers += 1;
        const reader = await User.create({
          login: `reader${readers}`,
          email: `reader${readers}@example.com`,
          password: 'hunter2hunter2',
          firstName: 'Rea',
          lastName: 'Der',
        });
        await Like.create({ userId: reader.id, bookId, isLike });
      }
    };
    const titlesOf = async (sort: 'popular' | 'new' | 'updated') => {
      const { items, total } = await page({ published: 'true', sort });
      return { titles: items.map((series) => series.title), total };
    };

    // S1 holds a Book released 5 days ago and one updated 1 day ago (and a
    // Chapter still scheduled); S2 one Book from 3 days ago; S3 only a scheduled
    // Chapter; S4 a Published Book with no Chapter; S5 only a Draft whose old
    // Chapter and Likes must not count.
    const rankedScenario = async () => {
      const s1 = await makeSeries('S1');
      await chapters((await fileBook(s1.id)).id, [daysFromNow(-5)]);
      await chapters((await fileBook(s1.id)).id, [
        daysFromNow(-1),
        daysFromNow(2),
      ]);
      const s2 = await makeSeries('S2');
      await chapters((await fileBook(s2.id)).id, [daysFromNow(-3)]);
      const s3 = await makeSeries('S3');
      await chapters((await fileBook(s3.id)).id, [daysFromNow(1)]);
      const s4 = await makeSeries('S4');
      await fileBook(s4.id);
      const s5 = await makeSeries('S5');
      const draft = await fileBook(s5.id, 'draft');
      await chapters(draft.id, [daysFromNow(-20)]);
      await react(draft.id, [true, true, true, true, true]);
    };

    test('a published, sorted list of an Account with no Series is empty, not an error', async () => {
      for (const sort of ['popular', 'new', 'updated'] as const) {
        assert.deepEqual(
          await page({ userId: ownerId, published: 'true', sort }),
          { items: [], total: 0 }
        );
      }
    });

    test('popular sums the Likes on its Published Books, dislikes and Drafts aside, ties newest first', async () => {
      const loved = await makeSeries('Loved');
      await react((await fileBook(loved.id)).id, [true]);
      await react((await fileBook(loved.id)).id, [true, true]);
      const mixed = await makeSeries('Mixed');
      await react((await fileBook(mixed.id)).id, [true, false, false]);
      await react((await fileBook(mixed.id, 'draft')).id, [
        true,
        true,
        true,
        true,
        true,
      ]);
      await fileBook((await makeSeries('Quiet A')).id);
      await fileBook((await makeSeries('Quiet B')).id);
      await fileBook((await makeSeries('Draft only')).id, 'draft');

      const popular = await titlesOf('popular');
      assert.deepEqual(popular.titles, [
        'Loved',
        'Mixed',
        'Quiet B',
        'Quiet A',
      ]);
      assert.equal(popular.total, 4);
    });

    test('new ranks by the earliest Release time among its Published Books, the unreleased last', async () => {
      await rankedScenario();

      // S2 (3 days) beats S1 (5 days); S4 then S3 have none, newest id first.
      assert.deepEqual(await titlesOf('new'), {
        titles: ['S2', 'S1', 'S4', 'S3'],
        total: 4,
      });
    });

    test('updated ranks by the latest Last update among its Published Books, a scheduled Chapter aside, the unreleased last', async () => {
      await rankedScenario();

      // S1 (1 day) beats S2 (3 days).
      assert.deepEqual(await titlesOf('updated'), {
        titles: ['S1', 'S2', 'S4', 'S3'],
        total: 4,
      });
    });

    test('a sorted list pages by limit and offset over the same order', async () => {
      await rankedScenario();

      const second = await page({
        published: 'true',
        sort: 'new',
        limit: 2,
        offset: 2,
      });

      assert.deepEqual(
        second.items.map((series) => series.title),
        ['S4', 'S3']
      );
      assert.equal(second.total, 4);
    });
  });

  // --- The contract the route specs' fake is held to, run here for real. ---

  let contractAccounts = 0;
  let contractGenres = 0;
  seriesRepositoryContract(async () => ({
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
    async aBookIn(seriesId) {
      const book = await createCreditedBook(
        { title: 'Contract Book', description: 'x', tags: [], seriesId },
        [ownerId]
      );
      return book.id;
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
