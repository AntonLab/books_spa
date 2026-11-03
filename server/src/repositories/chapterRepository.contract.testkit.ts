import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../types/errors.ts';
import type { ChapterRepository } from './chapterRepository.ts';
import type { Viewer } from './visibility.ts';

// An id no row in either implementation has.
const MISSING_ID = 999_999;

// What a contract case needs besides the repository: the rows it assumes exist
// before it starts. The real side writes them through the models on MySQL,
// the fake side into the seeds it handed its fake.
export interface ChapterRepositoryContractWorld {
  repository: ChapterRepository;
  // An account holding the Author Role exists; answers its id.
  anAuthor(): Promise<number>;
  // A published book credited to these accounts exists; answers its id.
  aBook(coAuthorIds: [number, ...number[]]): Promise<number>;
}

// Registers the cases every ChapterRepository must pass, each against a world
// `setUp` builds afresh. Called from chapterRepository.spec.ts against MySQL
// and from chapterRepository.fake.spec.ts against the fake the route specs use.
//
// Only what the controllers rely on belongs here: which calls answer null or
// false, which error names which resource, the Reading order a list hands on,
// and the fields they read. Visibility, publication rules, the version check
// and the reorder conflict are the real repository's alone, covered in its own
// spec.
export function chapterRepositoryContract(
  setUp: () => Promise<ChapterRepositoryContractWorld>
): void {
  // Sees every chapter, drafts included.
  const asModerator: Viewer = { id: MISSING_ID, role: 'superadmin' };

  const aChapter = (
    repository: ChapterRepository,
    bookId: number,
    title = 'Contract Chapter'
  ) =>
    repository.create({
      bookId,
      title,
      text: `The text of ${title}`,
      publishedAt: null,
    });

  test('contract: a new chapter is stored under its book, body and all', async () => {
    const { repository, anAuthor, aBook } = await setUp();
    const bookId = await aBook([await anAuthor()]);

    const created = await aChapter(repository, bookId, 'One');

    assert.equal(created.bookId, bookId);
    assert.equal(created.title, 'One');
    assert.equal(created.text, 'The text of One');
    assert.equal(created.publishedAt, null);
    const found = await repository.findById(created.id, asModerator);
    assert.equal(found?.id, created.id);
    assert.equal(found?.text, 'The text of One');
  });

  test('contract: a chapter for a missing book blames the book', async () => {
    const { repository } = await setUp();

    await assert.rejects(
      aChapter(repository, MISSING_ID),
      new NotFoundError('Book', MISSING_ID)
    );
  });

  test('contract: every lookup and write on a missing chapter or book answers null or false', async () => {
    const { repository } = await setUp();

    assert.equal(await repository.findById(MISSING_ID, asModerator), null);
    assert.equal(
      await repository.update(MISSING_ID, {
        title: 'Nobody',
        expectedUpdatedAt: new Date().toISOString(),
      }),
      null
    );
    assert.equal(await repository.remove(MISSING_ID), false);
    assert.equal(await repository.reorder(MISSING_ID, [1]), false);
    assert.equal(await repository.findCoAuthorIds(MISSING_ID), null);
  });

  // Compared as sets: the controllers only ask whether the caller is among
  // them, and the real lookup names no order.
  test('contract: a chapter is owned by its book co-authors', async () => {
    const { repository, anAuthor, aBook } = await setUp();
    const firstId = await anAuthor();
    const secondId = await anAuthor();
    const bookId = await aBook([firstId, secondId]);
    const created = await aChapter(repository, bookId);

    const sorted = (ids: number[] | null) =>
      ids === null ? null : [...ids].sort((a, b) => a - b);
    const expected = sorted([firstId, secondId]);

    assert.deepEqual(
      sorted(await repository.findCoAuthorIds(created.id)),
      expected
    );
  });

  test('contract: a book chapters are listed in the Reading order a reorder writes, without their bodies', async () => {
    const { repository, anAuthor, aBook } = await setUp();
    const bookId = await aBook([await anAuthor()]);
    const otherBookId = await aBook([await anAuthor()]);
    const one = await aChapter(repository, bookId, 'One');
    const two = await aChapter(repository, bookId, 'Two');
    const three = await aChapter(repository, bookId, 'Three');
    await aChapter(repository, otherBookId, 'Elsewhere');

    assert.equal(
      await repository.reorder(bookId, [three.id, one.id, two.id]),
      true
    );
    // A chapter added after the reorder goes to the end of it.
    await aChapter(repository, bookId, 'Four');

    const page = await repository.list(
      { limit: 20, offset: 0, bookId },
      asModerator
    );
    assert.deepEqual(
      page.items.map((chapter) => chapter.title),
      ['Three', 'One', 'Two', 'Four']
    );
    assert.equal(page.total, 4);
    assert.equal('text' in (page.items[0] ?? {}), false);
  });

  test('contract: an update applies the fields given and leaves the rest', async () => {
    const { repository, anAuthor, aBook } = await setUp();
    const bookId = await aBook([await anAuthor()]);
    const created = await aChapter(repository, bookId, 'Before');

    const updated = await repository.update(created.id, {
      title: 'After',
      expectedUpdatedAt: created.updatedAt.toISOString(),
    });

    assert.equal(updated?.id, created.id);
    assert.equal(updated?.bookId, bookId);
    assert.equal(updated?.title, 'After');
    assert.equal(updated?.text, 'The text of Before');
  });

  test('contract: a removed chapter is gone', async () => {
    const { repository, anAuthor, aBook } = await setUp();
    const bookId = await aBook([await anAuthor()]);
    const created = await aChapter(repository, bookId);

    assert.equal(await repository.remove(created.id), true);
    assert.equal(await repository.findById(created.id, asModerator), null);
    assert.equal(await repository.findCoAuthorIds(created.id), null);
    assert.equal(await repository.remove(created.id), false);
  });
}
