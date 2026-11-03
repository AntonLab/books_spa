import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_LIBRARY_COUNTS } from 'shared';
import { NotFoundError } from '../types/errors.ts';
import type { CreateBookInput } from '../types/book.ts';
import type { BookRepository } from './bookRepository.ts';
import { missingGenre } from './genreRepository.ts';
import type { Actor } from './notificationRepository.ts';

// An id no row in either implementation has.
const MISSING_ID = 999_999;

// What a contract case needs besides the repository: the rows it assumes exist
// before it starts. The real side writes them through the models on MySQL,
// the fake side into the seeds it handed its fake.
export interface BookRepositoryContractWorld {
  repository: BookRepository;
  // An account holding the Author Role exists; answers its id.
  anAuthor(): Promise<number>;
  // A series credited to these accounts, in this order, exists; answers its id.
  aSeries(coAuthorIds: [number, ...number[]]): Promise<number>;
  // A Genre exists; answers its id. It has no Owner and no name worth
  // asserting, so the world picks the name.
  aGenre(): Promise<number>;
}

// Registers the cases every BookRepository must pass, each against a world
// `setUp` builds afresh. Called from bookRepository.spec.ts against MySQL and
// from bookRepository.fake.spec.ts against the fake the route specs use.
//
// Only what the controllers rely on belongs here: which calls answer null or
// false, which error names which resource, the orders they hand on, and the
// fields they read. Draft visibility, the credit rules, the reorder conflict
// and notifications are the real repository's alone, covered in its own spec.
export function bookRepositoryContract(
  setUp: () => Promise<BookRepositoryContractWorld>
): void {
  const asActor = (id: number): Actor => ({ id, role: 'author' });

  const aBook = (
    repository: BookRepository,
    userId: number,
    fields: Partial<CreateBookInput> = {}
  ) =>
    repository.create({
      userId,
      seriesId: null,
      title: 'Contract Book',
      description: 'A book',
      tags: [],
      ...fields,
    });

  test('contract: a new book is a draft credited to its creator alone', async () => {
    const { repository, anAuthor, aSeries } = await setUp();
    const authorId = await anAuthor();
    const seriesId = await aSeries([authorId]);

    const created = await aBook(repository, authorId, {
      seriesId,
      title: 'First',
      tags: ['epic'],
    });

    assert.equal(created.status, 'draft');
    assert.equal(created.title, 'First');
    assert.equal(created.seriesId, seriesId);
    assert.deepEqual(created.tags, ['epic']);
    assert.deepEqual(
      created.authors.map((author) => author.id),
      [authorId]
    );
    assert.deepEqual(await repository.findCoAuthorIds(created.id), [authorId]);
  });

  test('contract: a create naming a missing series or account blames that one', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();

    await assert.rejects(
      aBook(repository, authorId, { seriesId: MISSING_ID }),
      new NotFoundError('Series', MISSING_ID)
    );
    await assert.rejects(
      aBook(repository, MISSING_ID),
      new NotFoundError('User', MISSING_ID)
    );
  });

  test('contract: every lookup and write on a missing book answers null or false', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const actor = asActor(authorId);
    const viewer = { id: authorId, role: 'author' } as const;

    assert.equal(await repository.findById(MISSING_ID), null);
    assert.equal(await repository.findDetailById(MISSING_ID, viewer), null);
    assert.equal(
      await repository.update(MISSING_ID, { title: 'Nobody' }),
      null
    );
    assert.equal(await repository.remove(MISSING_ID, actor), false);
    assert.equal(
      await repository.addCoAuthor(MISSING_ID, authorId, actor),
      null
    );
    assert.equal(
      await repository.removeCoAuthor(MISSING_ID, authorId, actor),
      null
    );
    assert.equal(await repository.findCoAuthorIds(MISSING_ID), null);
  });

  test('contract: findCoAuthorIds lists the co-authors in credit order', async () => {
    const { repository, anAuthor } = await setUp();
    const creatorId = await anAuthor();
    const earlierId = await anAuthor();
    const laterId = await anAuthor();
    const created = await aBook(repository, creatorId);

    // Against the order the accounts were made in, so an order by id fails.
    const added = await repository.addCoAuthor(
      created.id,
      laterId,
      asActor(creatorId)
    );
    await repository.addCoAuthor(created.id, earlierId, asActor(creatorId));

    assert.deepEqual(
      added?.authors.map((author) => author.id),
      [creatorId, laterId]
    );
    assert.deepEqual(await repository.findCoAuthorIds(created.id), [
      creatorId,
      laterId,
      earlierId,
    ]);

    const removed = await repository.removeCoAuthor(
      created.id,
      laterId,
      asActor(creatorId)
    );
    assert.deepEqual(
      removed?.authors.map((author) => author.id),
      [creatorId, earlierId]
    );
    assert.deepEqual(await repository.findCoAuthorIds(created.id), [
      creatorId,
      earlierId,
    ]);
  });

  test('contract: crediting a missing account blames the user', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId);

    await assert.rejects(
      repository.addCoAuthor(created.id, MISSING_ID, asActor(authorId)),
      new NotFoundError('User', MISSING_ID)
    );
  });

  test('contract: an update applies the fields given and leaves the rest', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId, {
      description: 'Kept',
      tags: ['kept'],
    });

    const updated = await repository.update(created.id, {
      title: 'Renamed',
      status: 'complete',
    });

    assert.equal(updated?.title, 'Renamed');
    assert.equal(updated?.status, 'complete');
    assert.equal(updated?.description, 'Kept');
    assert.deepEqual(updated?.tags, ['kept']);
    assert.deepEqual(
      updated?.authors.map((author) => author.id),
      [authorId]
    );
  });

  test('contract: an update leaves the series alone when seriesId is absent and unlinks on an explicit null', async () => {
    const { repository, anAuthor, aSeries } = await setUp();
    const authorId = await anAuthor();
    const seriesId = await aSeries([authorId]);
    const created = await aBook(repository, authorId, { seriesId });

    assert.equal(
      (await repository.update(created.id, { title: 'Still filed' }))?.seriesId,
      seriesId
    );
    assert.equal(
      (await repository.update(created.id, { seriesId: null }))?.seriesId,
      null
    );
    assert.equal((await repository.findById(created.id))?.seriesId, null);
  });

  test('contract: an update into a missing series blames the series', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId);

    await assert.rejects(
      repository.update(created.id, { seriesId: MISSING_ID }),
      new NotFoundError('Series', MISSING_ID)
    );
  });

  test('contract: a book detail names its series, and a standalone book none', async () => {
    const { repository, anAuthor, aSeries } = await setUp();
    const authorId = await anAuthor();
    const seriesId = await aSeries([authorId]);
    const filed = await aBook(repository, authorId, { seriesId });
    const standalone = await aBook(repository, authorId);
    // A Co-author reads their own draft whatever the visibility rules.
    const viewer = { id: authorId, role: 'author' } as const;

    const detail = await repository.findDetailById(filed.id, viewer);
    assert.equal(detail?.id, filed.id);
    assert.equal(detail?.series?.id, seriesId);
    assert.deepEqual(
      detail?.authors.map((author) => author.id),
      [authorId]
    );
    assert.equal(
      (await repository.findDetailById(standalone.id, viewer))?.series,
      null
    );
  });

  // Zero, not null, on both sides: the real repository's SUM over no chapter
  // is NULL, and a client adding it up would print "null".
  test('contract: a new book detail counts no comments, no words and no favorites', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId);

    const detail = await repository.findDetailById(created.id, {
      id: authorId,
      role: 'author',
    });

    assert.equal(detail?.commentCount, 0);
    assert.equal(detail?.wordCount, 0);
    assert.equal(detail?.favoriteCount, 0);
    assert.equal(detail?.viewerFavoriteId, null);
    assert.equal(detail?.viewerReadingStatus, null);
    assert.deepEqual(detail?.libraryCounts, EMPTY_LIBRARY_COUNTS);
  });

  test('contract: a removed book is gone, credits and all', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId);

    assert.equal(await repository.remove(created.id, asActor(authorId)), true);
    assert.equal(await repository.findById(created.id), null);
    assert.equal(await repository.findCoAuthorIds(created.id), null);
    assert.equal(await repository.remove(created.id, asActor(authorId)), false);
  });

  test('contract: a book carries its Series with its place among the Published books', async () => {
    const { repository, anAuthor, aSeries } = await setUp();
    const authorId = await anAuthor();
    const seriesId = await aSeries([authorId]);
    const alone = await aBook(repository, authorId);
    const first = await aBook(repository, authorId, {
      seriesId,
      title: 'First',
    });
    const second = await aBook(repository, authorId, {
      seriesId,
      title: 'Second',
    });
    const third = await aBook(repository, authorId, {
      seriesId,
      title: 'Third',
    });

    assert.equal(alone.series, null);
    assert.equal(first.series?.id, seriesId);
    assert.equal(first.series?.position, null);

    await repository.update(first.id, { status: 'in_progress' });
    await repository.update(third.id, { status: 'complete' });
    const listed = await repository.list(
      { current: 1, pageSize: 50, seriesId },
      { id: authorId, role: 'author' }
    );
    const byId = new Map(
      listed.items.map((item) => [item.id, item.series?.position])
    );
    assert.equal(byId.get(first.id), 1);
    assert.equal(byId.get(third.id), 2);
    const draftDetail = await repository.findDetailById(second.id, {
      id: authorId,
      role: 'author',
    });
    assert.equal(draftDetail?.series?.position, null);

    await repository.reorderInSeries(seriesId, [third.id, second.id, first.id]);
    const detail = await repository.findDetailById(first.id, {
      id: authorId,
      role: 'author',
    });
    assert.equal(detail?.series?.position, 2);
    assert.ok(detail?.series?.title);
  });

  test('contract: the series lists follow the Series order a reorder writes, and a later book is appended', async () => {
    const { repository, anAuthor, aSeries } = await setUp();
    const authorId = await anAuthor();
    const seriesId = await aSeries([authorId]);
    const one = await aBook(repository, authorId, { seriesId, title: 'One' });
    const two = await aBook(repository, authorId, { seriesId, title: 'Two' });
    const three = await aBook(repository, authorId, {
      seriesId,
      title: 'Three',
    });
    // Published, so the public list shows them to a Guest as well.
    for (const book of [one, two, three]) {
      await repository.update(book.id, { status: 'in_progress' });
    }

    assert.equal(
      await repository.reorderInSeries(seriesId, [three.id, one.id, two.id]),
      true
    );

    const page = await repository.list(
      { current: 1, pageSize: 20, seriesId },
      null
    );
    assert.deepEqual(
      page.items.map((book) => book.title),
      ['Three', 'One', 'Two']
    );
    assert.equal(page.total, 3);

    // Left a draft: the editor's list is the one that names it, as a summary.
    const four = await aBook(repository, authorId, { seriesId, title: 'Four' });
    const editorList = await repository.listInSeries(seriesId);
    assert.deepEqual(
      editorList?.map((book) => book.title),
      ['Three', 'One', 'Two', 'Four']
    );
    assert.deepEqual(editorList?.[3], {
      id: four.id,
      title: 'Four',
      status: 'draft',
      authors: four.authors,
    });
  });

  test('contract: a page past the end is served as the last non-empty page, and page 1 when nothing matches', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    for (const title of ['One', 'Two', 'Three']) {
      const book = await aBook(repository, authorId, { title });
      // Published, so the public list shows them to a Guest as well.
      await repository.update(book.id, { status: 'in_progress' });
    }

    const past = await repository.list(
      { current: 9, pageSize: 2, userId: authorId },
      null
    );
    assert.equal(past.current, 2);
    assert.equal(past.total, 3);
    assert.equal(past.items.length, 1);

    const none = await repository.list(
      { current: 4, pageSize: 2, userId: MISSING_ID },
      null
    );
    assert.deepEqual(
      { current: none.current, total: none.total, items: none.items },
      { current: 1, total: 0, items: [] }
    );
  });

  // Same-case text, so the fake's plain substring match and MySQL's
  // case-insensitive LIKE agree; the collation is the real side's alone.
  test('contract: ?q= finds a book by its title or its description', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    for (const fields of [
      { title: 'Dragon Rising', description: 'A book' },
      { title: 'Plain Title', description: 'Of a Dragon and a knight' },
      { title: 'Unrelated', description: 'Nothing here' },
    ]) {
      const book = await aBook(repository, authorId, fields);
      await repository.update(book.id, { status: 'in_progress' });
    }

    const found = await repository.list(
      { q: 'Dragon', userId: authorId, current: 1, pageSize: 10 },
      null
    );
    assert.deepEqual(found.items.map((book) => book.title).sort(), [
      'Dragon Rising',
      'Plain Title',
    ]);
  });

  test('contract: a missing series has no books to list or reorder', async () => {
    const { repository } = await setUp();

    assert.equal(await repository.listInSeries(MISSING_ID), null);
    assert.equal(await repository.reorderInSeries(MISSING_ID, [1]), false);
  });

  // A fresh book is a draft, so the viewer here is one of its co-authors
  // rather than a guest — the real repository hides a draft's cover from a
  // guest, and that visibility rule is bookRepository.spec.ts's alone to
  // cover. This case is only about the round-trip and the missing-book
  // answers.
  test('contract: a cover round-trips, and a missing book reports false/null', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const viewer = { id: authorId, role: 'author' } as const;
    const created = await aBook(repository, authorId);
    const missingId = created.id + 10_000;

    assert.equal(await repository.getCoverData(created.id, viewer), null);
    assert.equal(await repository.setCover(created.id, Buffer.from('a')), true);
    assert.deepEqual(
      (await repository.getCoverData(created.id, viewer))?.data,
      Buffer.from('a')
    );
    assert.equal(await repository.setCover(missingId, Buffer.from('a')), false);

    assert.equal(await repository.removeCover(created.id), true);
    assert.equal(await repository.getCoverData(created.id, viewer), null);
    // A cover that never existed is a no-op, not an error — but a missing
    // book itself is reported, exactly as setCover reports it.
    assert.equal(await repository.removeCover(missingId), false);
  });

  test('contract: a book with no Genre reports genre: null, never undefined', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();

    const created = await aBook(repository, authorId);

    assert.equal(created.genre, null);
    assert.ok('genre' in created);
  });

  test('contract: a book carries the Genre it was created with, on the detail too', async () => {
    const { repository, anAuthor, aGenre } = await setUp();
    const authorId = await anAuthor();
    const genreId = await aGenre();
    // `as const` so `role` is a Role rather than a widened string, exactly as
    // the "every lookup on a missing book" case above builds its viewer.
    const viewer = { id: authorId, role: 'author' } as const;

    const created = await aBook(repository, authorId, { genreId });

    assert.equal(created.genre?.id, genreId);
    assert.equal((await repository.findById(created.id))?.genre?.id, genreId);
    assert.equal(
      (await repository.findDetailById(created.id, viewer))?.genre?.id,
      genreId
    );
  });

  test('contract: an update leaves the Genre alone when genreId is absent and clears it on an explicit null', async () => {
    const { repository, anAuthor, aGenre } = await setUp();
    const authorId = await anAuthor();
    const genreId = await aGenre();
    const created = await aBook(repository, authorId, { genreId });

    const renamed = await repository.update(created.id, { title: 'Renamed' });
    assert.equal(renamed?.genre?.id, genreId);

    const cleared = await repository.update(created.id, { genreId: null });
    assert.equal(cleared?.genre, null);

    const refiled = await repository.update(created.id, { genreId });
    assert.equal(refiled?.genre?.id, genreId);
  });

  test('contract: a genreId that names no Genre is refused on create and on update', async () => {
    const { repository, anAuthor } = await setUp();
    const authorId = await anAuthor();
    const created = await aBook(repository, authorId);

    await assert.rejects(
      aBook(repository, authorId, { genreId: MISSING_ID }),
      missingGenre(MISSING_ID)
    );
    await assert.rejects(
      repository.update(created.id, { genreId: MISSING_ID }),
      missingGenre(MISSING_ID)
    );
  });
}
