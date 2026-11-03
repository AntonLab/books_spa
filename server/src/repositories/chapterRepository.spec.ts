process.env.NODE_ENV ??= 'test';

import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Sequelize } from 'sequelize';
import { createSequelize } from '../db/sequelize.ts';
import { ensureDatabase } from '../db/ensureDatabase.ts';
import { testDbConfig } from '../db/testDb.testkit.ts';
import { skipWithoutMysql } from '../db/mysqlProbe.testkit.ts';
import { initModels } from '../models/index.ts';
import { Book } from '../models/Book.ts';
import { Chapter } from '../models/Chapter.ts';
import { Series } from '../models/Series.ts';
import { User } from '../models/User.ts';
import { createCreditedBook } from '../models/creditedBook.testkit.ts';
import {
  AppError,
  NotFoundError,
  StateConflictError,
} from '../types/errors.ts';
import { createSequelizeChapterRepository } from './chapterRepository.ts';
import { chapterRepositoryContract } from './chapterRepository.contract.testkit.ts';
import type { Viewer } from './visibility.ts';

const skip = await skipWithoutMysql();

const DAY_MS = 24 * 60 * 60 * 1000;

const owner = {
  login: 'ChapterOwner',
  email: 'chapters@example.com',
  password: 'hunter2hunter2',
  firstName: 'Cora',
  lastName: 'Owner',
};

describe('chapterRepository against real MySQL', { skip }, () => {
  let sequelize: Sequelize;
  let ownerId: number;
  let bookId: number;
  const repository = createSequelizeChapterRepository();
  // Reads the tests below make when visibility is not what they are about: a
  // Moderator sees every chapter, drafts included.
  const asModerator: Viewer = { id: 0, role: 'superadmin' };
  // The tests that are not about publication work with chapters already out.
  const createPublished = (
    input: Omit<Parameters<typeof repository.create>[0], 'publishedAt'>
  ) => repository.create({ ...input, publishedAt: 'now' });

  before(async () => {
    const db = testDbConfig('chapters');
    await ensureDatabase(db);
    sequelize = createSequelize(db);
    initModels(sequelize);
    await sequelize.sync({ force: true });
  });

  after(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    // Children first: the foreign keys forbid clearing parents out from under
    // them.
    await Chapter.destroy({ where: {}, truncate: false });
    await Book.destroy({ where: {}, truncate: false });
    await Series.destroy({ where: {}, truncate: false });
    await User.destroy({ where: {}, truncate: false });
    ownerId = (await User.create(owner)).id;
    bookId = (
      await createCreditedBook(
        { title: 'Test Book', description: 'A novel', tags: [] },
        [ownerId]
      )
    ).id;
  });

  test('round-trips a chapter and returns its body from findById', async () => {
    const created = await createPublished({
      bookId,
      title: 'Chapter One',
      text: 'It was a dark night.',
    });

    const reloaded = await repository.findById(created.id, null);

    assert.equal(reloaded?.title, 'Chapter One');
    assert.equal(reloaded?.text, 'It was a dark night.');
    assert.equal(reloaded?.bookId, bookId);
  });

  // The point of MEDIUMTEXT: this body is over 65,535 bytes, so a TEXT column
  // would truncate it (or reject the insert under strict mode).
  test('a body larger than TEXT could hold survives intact', async () => {
    const long = 'a'.repeat(100_000);

    const created = await createPublished({
      bookId,
      title: 'Long',
      text: long,
    });

    assert.equal(
      (await repository.findById(created.id, null))?.text.length,
      100_000
    );
  });

  test('multi-byte text and titles survive, thanks to utf8mb4', async () => {
    const created = await createPublished({
      bookId,
      title: 'Chapter 1 📖',
      text: 'It was a dark night 🌙',
    });

    const reloaded = await repository.findById(created.id, null);

    assert.equal(reloaded?.title, 'Chapter 1 📖');
    assert.equal(reloaded?.text, 'It was a dark night 🌙');
  });

  test('the list omits the body entirely, rather than fetching and dropping it', async () => {
    await createPublished({ bookId, title: 'One', text: 'x'.repeat(50_000) });

    const { items } = await repository.list({ limit: 20, offset: 0 }, null);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'One');
    assert.ok(!('text' in (items[0] ?? {})));
  });

  test('the list filters by bookId and reports the unpaged total', async () => {
    const otherBook = await createCreditedBook(
      { title: 'Test Book', description: 'Another novel', tags: [] },
      [ownerId]
    );
    await createPublished({ bookId, title: 'Mine', text: 'a' });
    await createPublished({
      bookId: otherBook.id,
      title: 'Theirs',
      text: 'b',
    });

    const mine = await repository.list({ limit: 20, offset: 0, bookId }, null);

    assert.equal(mine.total, 1);
    assert.equal(mine.items[0]?.title, 'Mine');
  });

  test('q matches the title as well as the body', async () => {
    await createPublished({ bookId, title: 'The Storm', text: 'calm seas' });
    await createPublished({ bookId, title: 'Calm', text: 'a storm broke' });

    const found = await repository.list(
      { limit: 20, offset: 0, q: 'storm' },
      null
    );

    assert.equal(found.total, 2);
  });

  test('q treats LIKE metacharacters literally, so ?q=% matches nothing', async () => {
    await createPublished({ bookId, title: 'Plain', text: 'no wildcards' });

    const found = await repository.list({ limit: 20, offset: 0, q: '%' }, null);

    assert.equal(found.total, 0);
  });

  test('a create against an unknown book is a NotFoundError, not a raw FK error', async () => {
    await assert.rejects(
      createPublished({
        bookId: bookId + 10_000,
        title: 'Orphan',
        text: 'No book',
      }),
      (error: unknown) =>
        error instanceof NotFoundError &&
        /Book \d+ not found/.test(error.message)
    );
  });

  test('an update renames a chapter without disturbing its body', async () => {
    const created = await createPublished({
      bookId,
      title: 'Draft title',
      text: 'The body',
    });

    const updated = await repository.update(created.id, {
      title: 'Final',
      expectedUpdatedAt: created.updatedAt.toISOString(),
    });

    assert.equal(updated?.title, 'Final');
    assert.equal(updated?.text, 'The body');
  });

  test('the word count follows the text on create and on a save that carries text, and only then', async () => {
    const wordCountOf = async (id: number) =>
      (await Chapter.findByPk(id))?.wordCount;
    const created = await createPublished({
      bookId,
      title: 'Counted',
      text: '  It was   a dark\nnight.  ',
    });
    assert.equal(await wordCountOf(created.id), 5);

    // A save without text — a rename, a return to Draft — leaves it alone.
    const renamed = await repository.update(created.id, {
      title: 'Renamed',
      publishedAt: null,
      expectedUpdatedAt: created.updatedAt.toISOString(),
    });
    assert.equal(await wordCountOf(created.id), 5);

    const rewritten = await repository.update(created.id, {
      text: 'Shorter now.',
      expectedUpdatedAt: renamed!.updatedAt.toISOString(),
    });
    assert.equal(await wordCountOf(created.id), 2);

    // Whitespace passes the schema's min(1) but holds no word.
    await repository.update(created.id, {
      text: ' \n\t ',
      expectedUpdatedAt: rewritten!.updatedAt.toISOString(),
    });
    assert.equal(await wordCountOf(created.id), 0);
  });

  test('update and remove report a missing chapter rather than throwing', async () => {
    assert.equal(
      await repository.update(999_999, {
        title: 'x',
        expectedUpdatedAt: new Date().toISOString(),
      }),
      null
    );
    assert.equal(await repository.remove(999_999), false);
  });

  // The association's whole purpose: chapters have no life of their own.
  test('deleting a book takes its chapters with it', async () => {
    await createPublished({ bookId, title: 'One', text: 'a' });
    await createPublished({ bookId, title: 'Two', text: 'b' });

    await Book.destroy({ where: { id: bookId } });

    assert.equal(
      (await repository.list({ limit: 20, offset: 0 }, null)).total,
      0
    );
  });

  test('the chapters of a draft are hidden from everyone but its co-authors and moderators', async () => {
    const draftId = (
      await createCreditedBook(
        { title: 'Draft', description: 'Private', tags: [], status: 'draft' },
        [ownerId]
      )
    ).id;
    const hidden = await createPublished({
      bookId: draftId,
      title: 'Hidden',
      text: 'Not yet',
    });
    await createPublished({ bookId, title: 'Shown', text: 'Out now' });
    const stranger = ownerId + 1_000;

    const titles = async (viewer: Viewer): Promise<string[]> =>
      (await repository.list({ limit: 20, offset: 0 }, viewer)).items.map(
        (chapter) => chapter.title
      );

    for (const viewer of [
      null,
      { id: stranger, role: 'user' },
      { id: stranger, role: 'author' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Shown']);
      assert.equal(await repository.findById(hidden.id, viewer), null);
      assert.equal(
        (
          await repository.list(
            { limit: 20, offset: 0, bookId: draftId },
            viewer
          )
        ).total,
        0
      );
    }

    for (const viewer of [
      { id: ownerId, role: 'author' },
      { id: stranger, role: 'admin' },
      { id: stranger, role: 'superadmin' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Hidden', 'Shown']);
      assert.equal(
        (await repository.findById(hidden.id, viewer))?.title,
        'Hidden'
      );
    }
  });

  test('a chapter is owned by every co-author of its book', async () => {
    const coAuthorId = (
      await User.create({
        ...owner,
        login: 'ChapterCoAuthor',
        email: 'chapter-coauthor@example.com',
        role: 'author',
      })
    ).id;
    const sharedBookId = (
      await createCreditedBook(
        { title: 'Shared Book', description: 'Co-written', tags: [] },
        [ownerId, coAuthorId]
      )
    ).id;
    const chapter = await createPublished({
      bookId: sharedBookId,
      title: 'Chapter One',
      text: 'It was a dark night.',
    });

    // There is no chapters.userId: the owners are the book's Co-authors, and
    // denormalising them here would create a second source of truth that
    // diverges the moment a Co-author is added or leaves.
    assert.deepEqual(
      [...((await repository.findCoAuthorIds(chapter.id)) ?? [])].sort(),
      [ownerId, coAuthorId].sort()
    );
  });

  test('a missing chapter has no co-authors to report', async () => {
    assert.equal(await repository.findCoAuthorIds(999_999), null);
  });

  test('a chapter is saved as a draft, published now, or scheduled for later', async () => {
    const draft = await repository.create({
      bookId,
      title: 'Draft',
      text: 'a',
      publishedAt: null,
    });
    assert.equal(draft.publishedAt, null);

    const before = Date.now();
    const now = await repository.create({
      bookId,
      title: 'Now',
      text: 'b',
      publishedAt: 'now',
    });
    const stamped = now.publishedAt?.getTime() ?? 0;
    assert.ok(stamped >= before - 1_000 && stamped <= Date.now() + 1_000);

    const later = new Date(Date.now() + 2 * DAY_MS);
    const scheduled = await repository.create({
      bookId,
      title: 'Later',
      text: 'c',
      publishedAt: later.toISOString(),
    });
    assert.equal(scheduled.publishedAt?.getTime(), later.getTime());
  });

  test('a publication time in the past is refused', async () => {
    await assert.rejects(
      repository.create({
        bookId,
        title: 'Backdated',
        text: 'a',
        publishedAt: new Date(Date.now() - DAY_MS).toISOString(),
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 400 &&
        /past/i.test(error.message)
    );
  });

  test('a chapter moves between draft, scheduled and published, but a published time is fixed', async () => {
    let chapter = await repository.create({
      bookId,
      title: 'Moving',
      text: 'a',
      publishedAt: null,
    });
    const save = async (publishedAt: string | null) => {
      const saved = await repository.update(chapter.id, {
        publishedAt,
        expectedUpdatedAt: chapter.updatedAt.toISOString(),
      });
      assert.ok(saved);
      chapter = saved;
      return saved;
    };

    const tomorrow = new Date(Date.now() + DAY_MS);
    assert.equal(
      (await save(tomorrow.toISOString())).publishedAt?.getTime(),
      tomorrow.getTime()
    );

    const nextWeek = new Date(Date.now() + 7 * DAY_MS);
    assert.equal(
      (await save(nextWeek.toISOString())).publishedAt?.getTime(),
      nextWeek.getTime()
    );

    assert.equal((await save(null)).publishedAt, null);
    const published = await save('now');
    assert.ok((published.publishedAt?.getTime() ?? Infinity) <= Date.now());

    for (const value of ['now', nextWeek.toISOString()]) {
      await assert.rejects(
        repository.update(chapter.id, {
          publishedAt: value,
          expectedUpdatedAt: chapter.updatedAt.toISOString(),
        }),
        (error: unknown) =>
          error instanceof AppError && error.statusCode === 400
      );
    }

    // Its text can still change, and it can go back to being a draft.
    assert.equal(
      (
        await repository.update(chapter.id, {
          text: 'Revised',
          expectedUpdatedAt: chapter.updatedAt.toISOString(),
        })
      )?.publishedAt?.getTime(),
      published.publishedAt?.getTime()
    );
    chapter = (await repository.findById(chapter.id, asModerator)) ?? chapter;
    assert.equal((await save(null)).publishedAt, null);
  });

  test('a save based on a stale updatedAt is a conflict and writes nothing', async () => {
    const created = await repository.create({
      bookId,
      title: 'Shared',
      text: 'Original',
      publishedAt: null,
    });
    const seenByBoth = created.updatedAt.toISOString();

    await repository.update(created.id, {
      text: 'First co-author',
      expectedUpdatedAt: seenByBoth,
    });

    await assert.rejects(
      repository.update(created.id, {
        text: 'Second co-author',
        expectedUpdatedAt: seenByBoth,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 409 &&
        /changed/i.test(error.message)
    );
    assert.equal(
      (await repository.findById(created.id, asModerator))?.text,
      'First co-author'
    );
  });

  test('a reader sees only chapters whose publication time has passed; co-authors and moderators see all', async () => {
    await repository.create({
      bookId,
      title: 'Out',
      text: 'a',
      publishedAt: 'now',
    });
    const draft = await repository.create({
      bookId,
      title: 'Draft',
      text: 'b',
      publishedAt: null,
    });
    const scheduled = await repository.create({
      bookId,
      title: 'Scheduled',
      text: 'c',
      publishedAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    const stranger = ownerId + 1_000;

    const titles = async (viewer: Viewer): Promise<string[]> =>
      (
        await repository.list({ limit: 20, offset: 0, bookId }, viewer)
      ).items.map((chapter) => chapter.title);

    for (const viewer of [
      null,
      { id: stranger, role: 'user' },
      { id: stranger, role: 'author' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Out']);
      assert.equal(await repository.findById(draft.id, viewer), null);
      assert.equal(await repository.findById(scheduled.id, viewer), null);
    }

    for (const viewer of [
      { id: ownerId, role: 'author' },
      { id: stranger, role: 'admin' },
      { id: stranger, role: 'superadmin' },
    ] as const) {
      assert.deepEqual(await titles(viewer), ['Out', 'Draft', 'Scheduled']);
      assert.equal(
        (await repository.findById(scheduled.id, viewer))?.title,
        'Scheduled'
      );
    }
  });

  test('a scheduled chapter comes out on its own once its time passes', async () => {
    const soon = await repository.create({
      bookId,
      title: 'Soon',
      text: 'a',
      publishedAt: new Date(Date.now() + 1_500).toISOString(),
    });
    assert.equal(await repository.findById(soon.id, null), null);

    await new Promise((resolve) => setTimeout(resolve, 1_600));

    assert.equal((await repository.findById(soon.id, null))?.title, 'Soon');
  });

  // --- Reading order (CONTEXT.md). ---

  const titlesFor = async (viewer: Viewer = asModerator): Promise<string[]> =>
    (await repository.list({ limit: 20, offset: 0, bookId }, viewer)).items.map(
      (chapter) => chapter.title
    );

  test('a new chapter is appended at the end of the Reading order', async () => {
    const one = await createPublished({ bookId, title: 'One', text: 'a' });
    const two = await createPublished({ bookId, title: 'Two', text: 'b' });
    await repository.reorder(bookId, [two.id, one.id]);

    await createPublished({ bookId, title: 'Three', text: 'c' });

    assert.deepEqual(await titlesFor(), ['Two', 'One', 'Three']);
  });

  test('chapters created at the same moment still get a place each', async () => {
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((title) =>
        createPublished({ bookId, title, text: 'x' })
      )
    );

    const positions = (
      await Chapter.findAll({ where: { bookId }, attributes: ['position'] })
    ).map((chapter) => chapter.position);
    assert.equal(new Set(positions).size, 5);
  });

  test('a reorder rewrites the Reading order every list follows, readers included', async () => {
    const one = await createPublished({ bookId, title: 'One', text: 'a' });
    const draft = await repository.create({
      bookId,
      title: 'Draft',
      text: 'b',
      publishedAt: null,
    });
    const three = await createPublished({ bookId, title: 'Three', text: 'c' });

    assert.equal(
      await repository.reorder(bookId, [three.id, draft.id, one.id]),
      true
    );

    assert.deepEqual(await titlesFor(), ['Three', 'Draft', 'One']);
    assert.deepEqual(await titlesFor(null), ['Three', 'One']);
  });

  test('a reorder leaves every chapter version alone, so an open editor is not told it is stale', async () => {
    const one = await createPublished({ bookId, title: 'One', text: 'a' });
    const two = await createPublished({ bookId, title: 'Two', text: 'b' });

    await repository.reorder(bookId, [two.id, one.id]);

    const reloaded = await repository.findById(one.id, asModerator);
    assert.equal(reloaded?.updatedAt.getTime(), one.updatedAt.getTime());
  });

  test('a reorder that does not name exactly the chapters the book has now is a conflict and changes nothing', async () => {
    const one = await createPublished({ bookId, title: 'One', text: 'a' });
    const two = await createPublished({ bookId, title: 'Two', text: 'b' });
    const otherBook = await createCreditedBook(
      { title: 'Other', description: 'x', tags: [] },
      [ownerId]
    );
    const elsewhere = await createPublished({
      bookId: otherBook.id,
      title: 'Elsewhere',
      text: 'c',
    });

    for (const chapterIds of [
      [two.id], // one was added meanwhile
      [two.id, one.id, one.id + 10_000], // one was deleted meanwhile
      [two.id, elsewhere.id], // a chapter from another book
    ]) {
      await assert.rejects(
        repository.reorder(bookId, chapterIds),
        (error: unknown) => error instanceof StateConflictError,
        JSON.stringify(chapterIds)
      );
    }

    assert.deepEqual(await titlesFor(), ['One', 'Two']);
  });

  test('a reorder of a missing book reports it rather than throwing', async () => {
    assert.equal(await repository.reorder(bookId + 10_000, [1]), false);
  });

  // --- The contract the route specs' fake is held to, run here for real. ---

  let contractAccounts = 0;
  chapterRepositoryContract(async () => ({
    repository,
    async anAuthor() {
      contractAccounts += 1;
      const user = await User.create({
        ...owner,
        login: `ContractAuthor${contractAccounts}`,
        email: `contract-author-${contractAccounts}@example.com`,
        role: 'author',
      });
      return user.id;
    },
    async aBook(coAuthorIds) {
      const book = await createCreditedBook(
        { title: 'Contract Book', description: 'x', tags: [] },
        coAuthorIds
      );
      return book.id;
    },
  }));
});
