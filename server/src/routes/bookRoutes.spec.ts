import test from 'node:test';
import assert from 'node:assert/strict';
import type { ListBooksQuery } from '../types/book.ts';
import { StateConflictError } from '../types/errors.ts';
import type { BookRepository } from '../repositories/bookRepository.ts';
import {
  createFakeBookRepository,
  type FakeBookRepositoryOptions,
  type FakeSeries,
} from '../repositories/bookRepository.fake.testkit.ts';
import type { SeriesRepository } from '../repositories/seriesRepository.ts';
import type { Actor } from '../repositories/notificationRepository.ts';
import type { Viewer } from '../repositories/visibility.ts';
import type {
  BookDetail,
  PublicBook,
  PublicGenre,
  AuthorSummary,
} from 'shared';
import {
  aWebpImage,
  AUTH_COOKIE,
  json,
  lookupOnlyRepository,
  put,
  ROLE_COOKIES,
  USER_IDS,
  withApp,
  withAuthenticatedApp,
} from './routeTestKit.testkit.ts';

// Every book in this suite is created by the `author` persona by default —
// only `author` (and `admin`, on update/delete) has anything but `none` on
// books in the matrix — so the "known valid user" the fake repository accepts
// is that persona's id, not an arbitrary constant.
const KNOWN_USER_ID = USER_IDS.author;
const KNOWN_SERIES_ID = 7;
// A series that exists but belongs to `otherAuthor`, not to the `author`
// persona every book here is created by — the target an author must not be
// able to file a book under.
const OTHER_AUTHOR_SERIES_ID = 8;
const VIEWER_LIKE_ID = 99;
const VIEWER_FAVORITE_ID = 77;
const UNOWNED_USER_ID = 999997;

// Credited to otherAuthor first and the `author` persona second, so filing a
// book under it proves any Co-author of a series may, not only its first.
const SHARED_SERIES_ID = 9;

const KNOWN_GENRE_ID = 5;
const MISSING_GENRE_ID = 999996;

// The Genres that exist. A Genre has no Co-authors and no visibility rule, so
// one map serves every case here.
const GENRES = new Map<number, PublicGenre>([
  [KNOWN_GENRE_ID, { id: KNOWN_GENRE_ID, name: 'Gothic', parent: null }],
]);

// The series that exist, and who co-authors each.
const SERIES = new Map<number, FakeSeries>([
  [KNOWN_SERIES_ID, { title: 'The Cycle', coAuthorIds: [KNOWN_USER_ID] }],
  [
    OTHER_AUTHOR_SERIES_ID,
    { title: 'Not Yours', coAuthorIds: [USER_IDS.otherAuthor] },
  ],
  [
    SHARED_SERIES_ID,
    { title: 'Shared', coAuthorIds: [USER_IDS.otherAuthor, KNOWN_USER_ID] },
  ],
]);

// Deliberately spelled out rather than derived from a PublicUser: the point of
// the assertion below is that no email reaches the response, and a fixture
// built by deleting a key would not prove that.
const AUTHOR: AuthorSummary = {
  id: KNOWN_USER_ID,
  login: 'Author',
  firstName: 'Ann',
  lastName: 'Author',
  status: 'active',
  avatarUrl: null,
};

// Every persona a fake credit can name, so a response's `authors` carries real
// summaries rather than ids.
const SUMMARIES = new Map<number, AuthorSummary>([
  [KNOWN_USER_ID, AUTHOR],
  [
    USER_IDS.otherAuthor,
    {
      id: USER_IDS.otherAuthor,
      login: 'otherAuthor',
      firstName: 'O',
      lastName: 'A',
      status: 'active',
      avatarUrl: null,
    },
  ],
  [
    USER_IDS.user,
    {
      id: USER_IDS.user,
      login: 'TestUser',
      firstName: 'Test',
      lastName: 'User',
      status: 'active',
      avatarUrl: null,
    },
  ],
]);

// `viewers` collects who each read was made as. Whether a Draft book is
// readable is the real repository's decision, covered against MySQL; what the
// routes owe it is the right viewer, which is what a test can check here.
const createFakeRepository = (
  spies: Pick<FakeBookRepositoryOptions, 'viewers' | 'reorders' | 'actors'> = {}
): BookRepository =>
  createFakeBookRepository({
    accounts: SUMMARIES,
    series: SERIES,
    genres: GENRES,
    likes: { count: 4, viewerLikeId: VIEWER_LIKE_ID },
    favorites: { count: 3, viewerFavoriteId: VIEWER_FAVORITE_ID },
    tallies: { commentCount: 6, wordCount: 1200 },
    ...spies,
  });

// The book fake knows no series Co-authors; the guard reads them from the
// series repository, which here only answers that lookup.
const appDeps = (bookRepository = createFakeRepository()) => ({
  bookRepository,
  seriesRepository: lookupOnlyRepository<SeriesRepository>(
    'series',
    new Map(
      [...SERIES].map(([id, series]) => [id, series.coAuthorIds] as const)
    )
  ),
});

// No userId: the first Co-author comes from the session, never the body.
const valid = {
  seriesId: KNOWN_SERIES_ID,
  title: 'The First Book',
  description: 'The first book in the trilogy',
  tags: ['sci-fi', 'epic'],
};

// Defaults to the author persona: create and update both need `own` or `any`
// scope on books, and `user` has `none` on all three, so AUTH_COOKIE (the
// `user` persona) is no longer a usable default for a write in this file.
const post = (
  base: string,
  body: unknown,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/books`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const patch = (
  base: string,
  id: number,
  body: unknown,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/books/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const remove = (
  base: string,
  id: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/books/${id}`, {
    method: 'DELETE',
    headers: {
      ...(cookie ? { cookie } : {}),
    },
  });

test('POST creates a book credited to the caller and echoes its tags and series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, valid);
    const body = await json<PublicBook>(response);

    assert.equal(response.status, 201);
    assert.deepEqual(
      body.authors.map((author) => author.id),
      [KNOWN_USER_ID]
    );
    assert.equal(body.seriesId, KNOWN_SERIES_ID);
    assert.deepEqual(body.tags, ['sci-fi', 'epic']);
  });
});

test('POST defaults seriesId to null when omitted — a book need not be in a series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, {
      title: 'Standalone',
      description: 'Standalone',
    });

    assert.equal(response.status, 201);
    assert.equal((await json<PublicBook>(response)).seriesId, null);
  });
});

test('POST defaults tags to an empty array when omitted', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, {
      title: 'No Tags Yet',
      description: 'No tags yet',
    });

    assert.equal(response.status, 201);
    assert.deepEqual((await json<PublicBook>(response)).tags, []);
  });
});

test('POST collapses duplicate tags before storing them', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, {
      ...valid,
      tags: ['epic', 'epic', 'sci-fi'],
    });

    assert.deepEqual((await json<PublicBook>(response)).tags, [
      'epic',
      'sci-fi',
    ]);
  });
});

test('POST rejects a missing description with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, {});

    assert.equal(response.status, 400);
    assert.match(
      (await json<{ error: string }>(response)).error,
      /validation/i
    );
  });
});

test('POST rejects a non-numeric seriesId with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, { ...valid, seriesId: 'abc' });

    assert.equal(response.status, 400);
  });
});

// There is no longer a route-level way to reach an "unknown user" 404: userId
// is not client-controlled, and authStubs only ever resolves known personas.
// The repository-level mapping from a rejected FK to NotFoundError is still
// covered directly in bookRepository.spec.ts.

test('POST against an unknown series blames the series, not the user', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, { ...valid, seriesId: 999 });

    assert.equal(response.status, 404);
    assert.match(
      (await json<{ error: string }>(response)).error,
      /Series 999 not found/
    );
  });
});

test('PATCH by an author not credited on the book is 403 even when the series named does not exist', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(
      await post(base, { ...valid, seriesId: null }, ROLE_COOKIES.otherAuthor)
    );

    const response = await patch(base, id, { seriesId: 9999 });

    assert.equal(response.status, 403);
  });
});

test('GET list returns items with the page-numbered envelope', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, valid);
    const response = await fetch(`${base}/api/books`);
    const body = await json<{
      total: number;
      current: number;
      pageSize: number;
      items: unknown[];
    }>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(
      { total: body.total, current: body.current, pageSize: body.pageSize },
      { total: 1, current: 1, pageSize: 20 }
    );
    assert.equal(body.items.length, 1);
  });
});

test('GET list serves the last non-empty page past the end and refuses a bad page with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, valid);

    const past = await json<{ current: number; items: unknown[] }>(
      await fetch(`${base}/api/books?current=5&pageSize=10`)
    );
    assert.deepEqual(
      { current: past.current, count: past.items.length },
      { current: 1, count: 1 }
    );
    for (const query of ['current=0', 'pageSize=101', 'pageSize=0']) {
      assert.equal(
        (await fetch(`${base}/api/books?${query}`)).status,
        400,
        query
      );
    }
  });
});

test('GET list filters by tag, owner and series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, valid);
    await post(base, {
      title: 'Standalone',
      description: 'Standalone',
      tags: ['drama'],
    });

    const byTag = await json<{ total: number }>(
      await fetch(`${base}/api/books?tag=drama`)
    );
    const byUser = await json<{ total: number }>(
      await fetch(`${base}/api/books?userId=${KNOWN_USER_ID}`)
    );
    const bySeries = await json<{ total: number }>(
      await fetch(`${base}/api/books?seriesId=${KNOWN_SERIES_ID}`)
    );
    const byOther = await json<{ total: number }>(
      await fetch(`${base}/api/books?userId=${UNOWNED_USER_ID}`)
    );

    assert.equal(byTag.total, 1);
    assert.equal(byUser.total, 2);
    // The standalone book has no series, so only one of the two matches.
    assert.equal(bySeries.total, 1);
    assert.equal(byOther.total, 0);
  });
});

// The caller here is the `author` persona, which holds `none` on every
// genres action — choosing a Genre rides on the book's own create grant and
// needs no grant on genres at all. That is why this case asserts 201 as
// `author` rather than as `admin`.
test('POST files a book under a genre, and leaves it without one when genreId is absent', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const filed = await post(base, { ...valid, genreId: KNOWN_GENRE_ID });
    const without = await post(base, valid);

    assert.equal(filed.status, 201);
    assert.deepEqual((await json<PublicBook>(filed)).genre, {
      id: KNOWN_GENRE_ID,
      name: 'Gothic',
      parent: null,
    });
    assert.equal((await json<PublicBook>(without)).genre, null);
  });
});

// Choosing a Genre rides on the book's own create/update grant, so
// nothing extra is checked — but an id that names no Genre is a 400.
test('a genreId that names no genre is 400 on create and on update', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(await post(base, valid));

    const onCreate = await post(base, {
      ...valid,
      genreId: MISSING_GENRE_ID,
    });
    const onUpdate = await patch(base, created.id, {
      genreId: MISSING_GENRE_ID,
    });

    assert.equal(onCreate.status, 400);
    assert.equal(onUpdate.status, 400);
    const createBody = await json<{ error: string }>(onCreate);
    assert.match(createBody.error, /does not exist/);
    assert.ok(!('details' in createBody));
    const updateBody = await json<{ error: string }>(onUpdate);
    assert.match(updateBody.error, /does not exist/);
    assert.ok(!('details' in updateBody));
  });
});

test('PATCH without genreId keeps the genre, and an explicit null clears it', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, { ...valid, genreId: KNOWN_GENRE_ID })
    );

    const renamed = await json<PublicBook>(
      await patch(base, created.id, { title: 'Renamed' })
    );
    assert.equal(renamed.genre?.id, KNOWN_GENRE_ID);

    const cleared = await json<PublicBook>(
      await patch(base, created.id, { genreId: null })
    );
    assert.equal(cleared.genre, null);
  });
});

test('GET list with favoritedBy=me is 401 for a Guest and 400 for another value', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const guest = await fetch(`${base}/api/books?favoritedBy=me`);
    const bad = await fetch(`${base}/api/books?favoritedBy=you`);

    assert.equal(guest.status, 401);
    assert.equal(bad.status, 400);
  });
});

test('GET list passes hideNotInterested=true to the repository and answers 400 for false', async () => {
  const fake = createFakeRepository();
  const queries: ListBooksQuery[] = [];
  const bookRepository: BookRepository = {
    ...fake,
    list: (query, viewer) => {
      queries.push(query);
      return fake.list(query, viewer);
    },
  };
  await withAuthenticatedApp(appDeps(bookRepository), async (base) => {
    const hidden = await fetch(`${base}/api/books?hideNotInterested=true`);
    const bad = await fetch(`${base}/api/books?hideNotInterested=false`);

    assert.equal(hidden.status, 200);
    assert.equal(bad.status, 400);
    assert.equal(queries.length, 1);
    assert.equal(queries[0]?.hideNotInterested, 'true');
  });
});

test('GET list filters by genre', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, { ...valid, genreId: KNOWN_GENRE_ID });
    await post(base, valid);

    const inGenre = await json<{ total: number }>(
      await fetch(`${base}/api/books?genreId=${KNOWN_GENRE_ID}`)
    );
    const inMissing = await json<{ total: number }>(
      await fetch(`${base}/api/books?genreId=${MISSING_GENRE_ID}`)
    );

    assert.equal(inGenre.total, 1);
    assert.equal(inMissing.total, 0);
  });
});

test('GET list takes a known sort and refuses any other with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    for (const sort of ['popular', 'new', 'updated']) {
      assert.equal((await fetch(`${base}/api/books?sort=${sort}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/api/books?sort=oldest`)).status, 400);
  });
});

test('GET list takes published=true and refuses any other value with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal(
      (await fetch(`${base}/api/books?published=true&sort=new`)).status,
      200
    );
    for (const bad of ['false', '1', '']) {
      assert.equal(
        (await fetch(`${base}/api/books?published=${bad}`)).status,
        400,
        bad
      );
    }
  });
});

test('GET list takes ids and answers only those books, and refuses malformed ids with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const ids: number[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      const created = await json<{ id: number }>(
        await post(base, { ...valid, title })
      );
      ids.push(created.id);
    }
    const wanted = [ids[0], ids[2], 999_999];
    const body = await json<{ total: number; items: { id: number }[] }>(
      await fetch(`${base}/api/books?ids=${wanted.join(',')}`)
    );
    assert.deepEqual(body.items.map((item) => item.id).sort(), [
      ids[0],
      ids[2],
    ]);
    assert.equal(body.total, 2);

    for (const bad of ['', '1,', '0', 'abc', '1,1']) {
      assert.equal(
        (await fetch(`${base}/api/books?ids=${bad}`)).status,
        400,
        bad
      );
    }
  });
});

test('GET list takes every search filter together and refuses a bad one with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const everyFilter = new URLSearchParams({
      q: 'dragon',
      status: 'complete',
      releasedFrom: '2026-01-01T00:00:00.000Z',
      releasedTo: '2026-01-31T23:59:59.999Z',
      updatedFrom: '2026-01-01T00:00:00.000Z',
      author: 'ann',
      seriesTitle: 'cycle',
      genreId: String(KNOWN_GENRE_ID),
      sort: 'new',
      current: '1',
      pageSize: '20',
    });
    assert.equal((await fetch(`${base}/api/books?${everyFilter}`)).status, 200);

    for (const query of [
      'status=draft',
      'q=%20%20',
      `author=${'a'.repeat(201)}`,
      'releasedFrom=2026-01-01',
    ]) {
      assert.equal(
        (await fetch(`${base}/api/books?${query}`)).status,
        400,
        query
      );
    }

    const reversed = await fetch(
      `${base}/api/books?updatedFrom=2026-02-01T00:00:00.000Z&updatedTo=2026-01-01T00:00:00.000Z`
    );
    const body = await json<{ details: { path: string[] }[] }>(reversed);
    assert.equal(reversed.status, 400);
    assert.deepEqual(body.details[0]?.path, ['updatedFrom']);
  });
});

test('GET by id embeds the co-authors and series, and never an email', async () => {
  // Seeded through the authenticated harness because POST is guarded, then read
  // back with no cookie at all: that is what proves the detail read stays
  // public and that an anonymous visitor gets an empty viewerLikeId.
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, valid);

    const response = await fetch(`${base}/api/books/1`);
    assert.equal(response.status, 200);

    const body = await json<BookDetail>(response);
    assert.equal(body.authors[0]?.login, 'Author');
    assert.equal('email' in (body.authors[0] ?? {}), false);
    assert.equal(body.series?.title, 'The Cycle');
    assert.equal(body.likeCount, 4);
    assert.equal(body.commentCount, 6);
    assert.equal(body.wordCount, 1200);
    assert.equal(body.viewerLikeId, null);
    assert.equal(body.favoriteCount, 3);
    assert.equal(body.viewerFavoriteId, null);
  });
});

test('GET by id reports the viewer own like when signed in', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    await post(base, valid);

    const response = await fetch(`${base}/api/books/1`, {
      headers: { cookie: AUTH_COOKIE },
    });

    const body = await json<BookDetail>(response);
    assert.equal(body.viewerLikeId, VIEWER_LIKE_ID);
    assert.equal(body.viewerFavoriteId, VIEWER_FAVORITE_ID);
  });
});

test('GET by id carries the Library counts for all, the Reading status for the viewer, and the list neither', async () => {
  const counts = { reading: 2, planToRead: 1, read: 4, inLibraries: 7 };
  const bookRepository = createFakeBookRepository({
    accounts: SUMMARIES,
    series: SERIES,
    genres: GENRES,
    library: { counts, viewerStatus: 'read' },
  });
  await withAuthenticatedApp(appDeps(bookRepository), async (base) => {
    await post(base, valid);

    const signedIn = await json<BookDetail>(
      await fetch(`${base}/api/books/1`, { headers: { cookie: AUTH_COOKIE } })
    );
    const guest = await json<BookDetail>(await fetch(`${base}/api/books/1`));
    const list = await json<{ items: object[] }>(
      await fetch(`${base}/api/books`)
    );

    assert.equal(signedIn.viewerReadingStatus, 'read');
    assert.deepEqual(signedIn.libraryCounts, counts);
    assert.equal(guest.viewerReadingStatus, null);
    assert.deepEqual(guest.libraryCounts, counts);
    assert.equal('viewerReadingStatus' in (list.items[0] ?? {}), false);
    assert.equal('libraryCounts' in (list.items[0] ?? {}), false);
  });
});

test('GET by id returns 404 for a missing record', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal((await fetch(`${base}/api/books/999`)).status, 404);
  });
});

test('GET by id rejects a non-numeric id with 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal((await fetch(`${base}/api/books/abc`)).status, 400);
  });
});

test('PATCH replaces tags but leaves them alone when omitted', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    const retagged = await json<PublicBook>(
      await patch(base, id, { tags: ['drama'] })
    );
    assert.deepEqual(retagged.tags, ['drama']);

    const renamed = await json<PublicBook>(
      await patch(base, id, { description: 'Rewritten' })
    );
    assert.equal(renamed.description, 'Rewritten');
    assert.deepEqual(renamed.tags, ['drama']);
  });
});

// The interesting case: `.partial()` does not undo `.default()`, so a PATCH
// schema derived from the create schema would parse this body as
// `seriesId: null` and silently unlink the book.
test('PATCH omitting seriesId leaves the book in its series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    const patched = await json<PublicBook>(
      await patch(base, id, { description: 'Rewritten' })
    );

    assert.equal(patched.seriesId, KNOWN_SERIES_ID);
  });
});

test('PATCH with an explicit null seriesId unlinks the book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    const patched = await json<PublicBook>(
      await patch(base, id, { seriesId: null })
    );

    assert.equal(patched.seriesId, null);
  });
});

test('PATCH cannot re-parent a book to another user', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    // userId is not in updateBookSchema, so a body carrying only it has no
    // recognised keys and fails the "at least one field" refinement.
    const response = await patch(base, id, { userId: 2 });

    assert.equal(response.status, 400);
  });
});

test('PATCH with an empty body is a 400', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    assert.equal((await patch(base, id, {})).status, 400);
  });
});

test('PATCH on a missing record is a 404', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal((await patch(base, 999, { tags: [] })).status, 404);
  });
});

test('DELETE removes the book, then reports 404 on a second attempt', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    const first = await remove(base, id);
    const second = await remove(base, id);

    assert.equal(first.status, 204);
    assert.equal(second.status, 404);
  });
});

test('POST without a session is 401', async () => {
  await withApp(appDeps(), async (base) => {
    assert.equal((await post(base, valid, null)).status, 401);
  });
});

test('PATCH without a session is 401', async () => {
  await withApp(appDeps(), async (base) => {
    assert.equal((await patch(base, 1, { tags: [] }, null)).status, 401);
  });
});

test('DELETE without a session is 401', async () => {
  await withApp(appDeps(), async (base) => {
    assert.equal((await remove(base, 1, null)).status, 401);
  });
});

test('GET stays public', async () => {
  await withApp(appDeps(), async (base) => {
    assert.equal((await fetch(`${base}/api/books`)).status, 200);
  });
});

// --- The permission matrix: who may create, edit and delete a book. ---

test('an author creates a book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, valid, ROLE_COOKIES.author);
    assert.equal(response.status, 201);
  });
});

test('a plain user may not create a book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, valid, ROLE_COOKIES.user);
    assert.equal(response.status, 403);
  });
});

test('an admin may not create a book either', async () => {
  // Admins moderate; they do not author. The one deliberate break in the
  // accumulation of roles.
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, valid, ROLE_COOKIES.admin);
    assert.equal(response.status, 403);
  });
});

test('an author may not edit another author book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    const response = await patch(
      base,
      created.id,
      { description: 'Hijacked' },
      ROLE_COOKIES.otherAuthor
    );
    assert.equal(response.status, 403);
  });
});

test('an author may not delete another author book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    const response = await remove(base, created.id, ROLE_COOKIES.otherAuthor);
    assert.equal(response.status, 403);

    // The row must survive the refused attempt, not just the status code.
    const stillThere = await fetch(`${base}/api/books/${created.id}`);
    assert.equal(stillThere.status, 200);
  });
});

test('an admin may edit and delete any book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    assert.equal(
      (
        await patch(
          base,
          created.id,
          { description: 'Fixed' },
          ROLE_COOKIES.admin
        )
      ).status,
      200
    );
    assert.equal(
      (await remove(base, created.id, ROLE_COOKIES.admin)).status,
      204
    );
  });
});

// --- Filing a book under a series: the series has to be the caller's too. ---

test('an author may not create a book in another author series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(
      base,
      { ...valid, seriesId: OTHER_AUTHOR_SERIES_ID },
      ROLE_COOKIES.author
    );
    assert.equal(response.status, 403);

    // Refused before the write, not written and then reported: the other
    // author's series must not start listing the book.
    const listed = await json<{ total: number }>(
      await fetch(`${base}/api/books?seriesId=${OTHER_AUTHOR_SERIES_ID}`)
    );
    assert.equal(listed.total, 0);
  });
});

test('an author may not move their own book into another author series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    const response = await patch(
      base,
      created.id,
      { seriesId: OTHER_AUTHOR_SERIES_ID },
      ROLE_COOKIES.author
    );
    assert.equal(response.status, 403);

    const stored = await json<PublicBook>(
      await fetch(`${base}/api/books/${created.id}`)
    );
    assert.equal(stored.seriesId, KNOWN_SERIES_ID);
  });
});

test('an author may create a book in their own series', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(
      base,
      { ...valid, seriesId: KNOWN_SERIES_ID },
      ROLE_COOKIES.author
    );

    assert.equal(response.status, 201);
    assert.equal((await json<PublicBook>(response)).seriesId, KNOWN_SERIES_ID);
  });
});

test('an author may unlink their book with seriesId: null', async () => {
  // Leaving a series touches no series, so there is nothing to check.
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    const response = await patch(
      base,
      created.id,
      { seriesId: null },
      ROLE_COOKIES.author
    );

    assert.equal(response.status, 200);
    assert.equal((await json<PublicBook>(response)).seriesId, null);
  });
});

test('an admin may file any book under any series', async () => {
  // `any` skips the series check just as it skips the book's.
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(
      await post(base, valid, ROLE_COOKIES.author)
    );

    const response = await patch(
      base,
      created.id,
      { seriesId: OTHER_AUTHOR_SERIES_ID },
      ROLE_COOKIES.admin
    );

    assert.equal(response.status, 200);
    assert.equal(
      (await json<PublicBook>(response)).seriesId,
      OTHER_AUTHOR_SERIES_ID
    );
  });
});

// --- Co-authors: every one of them may touch the book (ADR-0005). ---

const addCoAuthor = (
  base: string,
  bookId: number,
  userId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/books/${bookId}/co-authors`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ userId }),
  });

const removeCoAuthor = (
  base: string,
  bookId: number,
  userId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/books/${bookId}/co-authors/${userId}`, {
    method: 'DELETE',
    headers: { ...(cookie ? { cookie } : {}) },
  });

test('a co-author credited by the author may edit the book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    const added = await addCoAuthor(base, id, USER_IDS.otherAuthor);
    assert.equal(added.status, 200);
    assert.deepEqual(
      (await json<PublicBook>(added)).authors.map((author) => author.id),
      [KNOWN_USER_ID, USER_IDS.otherAuthor]
    );

    const response = await patch(
      base,
      id,
      { description: 'Co-written' },
      ROLE_COOKIES.otherAuthor
    );
    assert.equal(response.status, 200);
  });
});

test('a co-author may remove another co-author', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));
    await addCoAuthor(base, id, USER_IDS.otherAuthor);

    const response = await removeCoAuthor(
      base,
      id,
      KNOWN_USER_ID,
      ROLE_COOKIES.otherAuthor
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      (await json<PublicBook>(response)).authors.map((author) => author.id),
      [USER_IDS.otherAuthor]
    );
  });
});

test('a co-author who is no longer an author may still leave', async () => {
  // The `user` persona stands in for an author who switched Role: the matrix
  // gives it `none` on books, and leaving must not depend on that grant.
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));
    await addCoAuthor(base, id, USER_IDS.user);

    const response = await removeCoAuthor(
      base,
      id,
      USER_IDS.user,
      ROLE_COOKIES.user
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      (await json<PublicBook>(response)).authors.map((author) => author.id),
      [KNOWN_USER_ID]
    );
  });
});

test('a moderator may not change who is credited on a book', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));
    await addCoAuthor(base, id, USER_IDS.otherAuthor);

    for (const moderator of [ROLE_COOKIES.admin, ROLE_COOKIES.superadmin]) {
      assert.equal(
        (await addCoAuthor(base, id, USER_IDS.user, moderator)).status,
        403
      );
      assert.equal(
        (await removeCoAuthor(base, id, USER_IDS.otherAuthor, moderator))
          .status,
        403
      );
    }

    const stored = await json<PublicBook>(
      await fetch(`${base}/api/books/${id}`)
    );
    assert.deepEqual(
      stored.authors.map((author) => author.id),
      [KNOWN_USER_ID, USER_IDS.otherAuthor]
    );
  });
});

test('changing co-authors without a session is 401', async () => {
  await withApp(appDeps(), async (base) => {
    assert.equal((await addCoAuthor(base, 1, 2, null)).status, 401);
    assert.equal((await removeCoAuthor(base, 1, 2, null)).status, 401);
  });
});

test('crediting a co-author on a missing book is a 404', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal(
      (await addCoAuthor(base, 999, USER_IDS.otherAuthor)).status,
      404
    );
    assert.equal(
      (await removeCoAuthor(base, 999, KNOWN_USER_ID, ROLE_COOKIES.author))
        .status,
      404
    );
  });
});

test('any co-author of a series may file a book under it, not only its first', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(
      base,
      { ...valid, seriesId: SHARED_SERIES_ID },
      ROLE_COOKIES.author
    );

    assert.equal(response.status, 201);
    assert.equal((await json<PublicBook>(response)).seriesId, SHARED_SERIES_ID);
  });
});

// --- Book status: every book starts as a draft (CONTEXT.md). ---

test('POST ignores a status in the body — every book starts as a draft', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await post(base, { ...valid, status: 'complete' });

    assert.equal(response.status, 201);
    assert.equal((await json<PublicBook>(response)).status, 'draft');
  });
});

test('PATCH moves a book to any status and rejects an unknown one', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const { id } = await json<PublicBook>(await post(base, valid));

    for (const status of ['complete', 'in_progress', 'draft']) {
      const response = await patch(base, id, { status });
      assert.equal(response.status, 200);
      assert.equal((await json<PublicBook>(response)).status, status);
    }
    assert.equal((await patch(base, id, { status: 'published' })).status, 400);
  });
});

test('reads are made as the signed-in caller, or as a guest', async () => {
  const viewers: Viewer[] = [];
  await withAuthenticatedApp(
    appDeps(createFakeRepository({ viewers })),
    async (base) => {
      await post(base, valid);

      await fetch(`${base}/api/books/1`);
      await fetch(`${base}/api/books?userId=${KNOWN_USER_ID}`, {
        headers: { cookie: ROLE_COOKIES.author },
      });
      await fetch(`${base}/api/books/1`, {
        headers: { cookie: ROLE_COOKIES.admin },
      });

      assert.deepEqual(viewers, [
        null,
        { id: KNOWN_USER_ID, role: 'author' },
        { id: USER_IDS.admin, role: 'admin' },
      ]);
    }
  );
});

// --- The series editor's book list and its Series order (CONTEXT.md). ---

const seriesBooks = (
  base: string,
  seriesId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${seriesId}/books`, {
    ...(cookie ? { headers: { cookie } } : {}),
  });

const putSeriesOrder = (
  base: string,
  seriesId: number,
  body: unknown,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${seriesId}/book-order`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

test('the series editor lists every book filed in the series, drafts included, as summaries', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const created = await json<PublicBook>(await post(base, valid));
    assert.equal(created.status, 'draft');

    const response = await seriesBooks(base, KNOWN_SERIES_ID);
    const body = await json<{ items: unknown[] }>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body.items, [
      {
        id: created.id,
        title: created.title,
        status: 'draft',
        authors: [AUTHOR],
      },
    ]);
  });
});

test('the series editor list takes a co-author of the series, or a moderator', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    assert.equal((await seriesBooks(base, KNOWN_SERIES_ID, null)).status, 401);
    assert.equal(
      (await seriesBooks(base, KNOWN_SERIES_ID, ROLE_COOKIES.user)).status,
      403
    );
    assert.equal(
      (await seriesBooks(base, KNOWN_SERIES_ID, ROLE_COOKIES.otherAuthor))
        .status,
      403
    );
    assert.equal(
      (await seriesBooks(base, SHARED_SERIES_ID, ROLE_COOKIES.otherAuthor))
        .status,
      200
    );
    assert.equal(
      (await seriesBooks(base, OTHER_AUTHOR_SERIES_ID, ROLE_COOKIES.admin))
        .status,
      200
    );
    assert.equal((await seriesBooks(base, 999)).status, 404);
    assert.equal(
      (await seriesBooks(base, 999, ROLE_COOKIES.admin)).status,
      404
    );
  });
});

test('PUT book-order hands the repository the new Series order and answers 204', async () => {
  const reorders: FakeBookRepositoryOptions['reorders'] = [];
  await withAuthenticatedApp(
    appDeps(createFakeRepository({ reorders })),
    async (base) => {
      const response = await putSeriesOrder(base, KNOWN_SERIES_ID, {
        bookIds: [3, 1, 2],
      });

      assert.equal(response.status, 204);
      assert.deepEqual(reorders, [
        { seriesId: KNOWN_SERIES_ID, bookIds: [3, 1, 2] },
      ]);
    }
  );
});

test('PUT book-order refuses a bad list with 400 and a stranger with 403', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    for (const bookIds of [[], [1, 1]]) {
      assert.equal(
        (await putSeriesOrder(base, KNOWN_SERIES_ID, { bookIds })).status,
        400
      );
    }
    const body = { bookIds: [1, 2] };
    assert.equal(
      (await putSeriesOrder(base, KNOWN_SERIES_ID, body, null)).status,
      401
    );
    assert.equal(
      (
        await putSeriesOrder(
          base,
          KNOWN_SERIES_ID,
          body,
          ROLE_COOKIES.otherAuthor
        )
      ).status,
      403
    );
    assert.equal(
      (
        await putSeriesOrder(
          base,
          OTHER_AUTHOR_SERIES_ID,
          body,
          ROLE_COOKIES.admin
        )
      ).status,
      204
    );
    assert.equal((await putSeriesOrder(base, 999, body)).status, 404);
  });
});

test('a series reorder conflict from the repository reaches the caller as a 409', async () => {
  const repository = createFakeRepository();
  await withAuthenticatedApp(
    appDeps({
      ...repository,
      async reorderInSeries() {
        throw new StateConflictError(
          'The books of this series changed since you loaded them'
        );
      },
    }),
    async (base) => {
      const response = await putSeriesOrder(base, KNOWN_SERIES_ID, {
        bookIds: [1, 2],
      });

      assert.equal(response.status, 409);
    }
  );
});

// --- Notifications name who acted, so the routes must say who that was. ---

test('credit changes and deletes are made as the signed-in caller, whom their notifications name', async () => {
  const actors: [string, Actor][] = [];
  await withAuthenticatedApp(
    appDeps(createFakeRepository({ actors })),
    async (base) => {
      const { id } = await json<PublicBook>(await post(base, valid));
      await addCoAuthor(base, id, USER_IDS.otherAuthor);
      await removeCoAuthor(
        base,
        id,
        USER_IDS.otherAuthor,
        ROLE_COOKIES.otherAuthor
      );
      await remove(base, id, ROLE_COOKIES.admin);

      assert.deepEqual(actors, [
        ['addCoAuthor', { id: USER_IDS.author, role: 'author' }],
        ['removeCoAuthor', { id: USER_IDS.otherAuthor, role: 'author' }],
        ['remove', { id: USER_IDS.admin, role: 'admin' }],
      ]);
    }
  );
});

// --- A Book Cover, uploaded, replaced, removed and served. ---

test('PUT /api/books/:id/cover answers 401 with no session', async () => {
  await withApp({}, async (base) => {
    const response = await put(
      `${base}/api/books/${KNOWN_SERIES_ID}/cover`,
      undefined,
      await aWebpImage()
    );
    assert.equal(response.status, 401);
  });
});

test('PUT /api/books/:id/cover answers 404 before 403 for a book that does not exist', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    const response = await put(
      `${base}/api/books/999999/cover`,
      ROLE_COOKIES.author,
      await aWebpImage()
    );
    assert.equal(response.status, 404);
  });
});

test('PUT /api/books/:id/cover answers 403 for a signed-in author who does not co-author the book', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: USER_IDS.otherAuthor,
    seriesId: null,
    title: 'Not yours',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await put(
      `${base}/api/books/${created.id}/cover`,
      ROLE_COOKIES.author,
      await aWebpImage()
    );
    assert.equal(response.status, 403);
  });
});

test('PUT /api/books/:id/cover answers 413 for a body over 2 MiB', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Big upload',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await put(
      `${base}/api/books/${created.id}/cover`,
      ROLE_COOKIES.author,
      Buffer.alloc(2 * 1024 * 1024 + 1)
    );
    assert.equal(response.status, 413);
  });
});

test('PUT /api/books/:id/cover answers 415 for an unaccepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Wrong type',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await fetch(`${base}/api/books/${created.id}/cover`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', cookie: ROLE_COOKIES.author },
      body: 'not an image',
    });
    assert.equal(response.status, 415);
  });
});

test('PUT /api/books/:id/cover answers 400 for bytes that are not a real image, even under an accepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Not really an image',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await fetch(`${base}/api/books/${created.id}/cover`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', cookie: ROLE_COOKIES.author },
      body: Buffer.from('not a real png'),
    });
    assert.equal(response.status, 400);
  });
});

test('PUT /api/books/:id/cover answers 400 for an empty body, even under an accepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Empty upload',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await fetch(`${base}/api/books/${created.id}/cover`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', cookie: ROLE_COOKIES.author },
      body: Buffer.alloc(0),
    });
    assert.equal(response.status, 400);
  });
});

test('PUT /api/books/:id/cover replaces the cover and answers with the updated book, its coverUrl version changing', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Gets a cover',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const first = await put(
      `${base}/api/books/${created.id}/cover`,
      ROLE_COOKIES.author,
      await aWebpImage()
    );
    assert.equal(first.status, 200);
    const firstBody = await json<PublicBook>(first);
    assert.match(
      firstBody.coverUrl ?? '',
      new RegExp(`^/api/books/${created.id}/cover\\?v=\\d+$`)
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await put(
      `${base}/api/books/${created.id}/cover`,
      ROLE_COOKIES.author,
      await aWebpImage(200, 300)
    );
    const secondBody = await json<PublicBook>(second);
    assert.notEqual(secondBody.coverUrl, firstBody.coverUrl);
  });
});

test('DELETE /api/books/:id/cover answers 401, then 404, then 403, in that order, and 204 on success — including with no cover', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'For deletion tests',
    description: 'x',
    tags: [],
  });
  const strangersBook = await repository.create({
    userId: USER_IDS.otherAuthor,
    seriesId: null,
    title: 'Not the author persona’s',
    description: 'x',
    tags: [],
  });

  await withApp(appDeps(repository), async (base) => {
    const noSession = await fetch(`${base}/api/books/${created.id}/cover`, {
      method: 'DELETE',
    });
    assert.equal(noSession.status, 401);
  });

  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const missing = await fetch(`${base}/api/books/999999/cover`, {
      method: 'DELETE',
      headers: { cookie: ROLE_COOKIES.author },
    });
    assert.equal(missing.status, 404);

    const forbidden = await fetch(
      `${base}/api/books/${strangersBook.id}/cover`,
      { method: 'DELETE', headers: { cookie: ROLE_COOKIES.author } }
    );
    assert.equal(forbidden.status, 403);

    const success = await fetch(`${base}/api/books/${created.id}/cover`, {
      method: 'DELETE',
      headers: { cookie: ROLE_COOKIES.author },
    });
    assert.equal(success.status, 204);
  });
});

test('DELETE /api/books/:id/cover answers 404 for a missing book even under `any` scope (a Moderator)', async () => {
  const repository = createFakeRepository();
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    const response = await fetch(`${base}/api/books/999999/cover`, {
      method: 'DELETE',
      headers: { cookie: ROLE_COOKIES.admin },
    });
    assert.equal(response.status, 404);
  });
});

test('PUT /api/books/:id/cover answers 404 for a missing book under `any` scope (a Moderator) before reading the image', async () => {
  await withAuthenticatedApp(appDeps(), async (base) => {
    // Bytes sharp refuses with a 400, so a 404 proves the Book was looked
    // up before processCoverImage ran.
    const response = await fetch(`${base}/api/books/999999/cover`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', cookie: ROLE_COOKIES.admin },
      body: Buffer.from('not a real png'),
    });
    assert.equal(response.status, 404);
  });
});

test('GET /api/books/:id/cover answers 404 for a book with no cover, and for a missing book', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'No cover',
    description: 'x',
    tags: [],
  });
  await withApp(appDeps(repository), async (base) => {
    assert.equal(
      (await fetch(`${base}/api/books/${created.id}/cover`)).status,
      404
    );
    assert.equal((await fetch(`${base}/api/books/999999/cover`)).status, 404);
  });
});

test('GET /api/books/:id/cover serves the WebP bytes with the versioned cache headers, publicly (a guest included)', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: KNOWN_USER_ID,
    seriesId: null,
    title: 'Has a cover',
    description: 'x',
    tags: [],
  });
  await withAuthenticatedApp(appDeps(repository), async (base) => {
    await put(
      `${base}/api/books/${created.id}/cover`,
      ROLE_COOKIES.author,
      await aWebpImage()
    );
  });
  await withApp(appDeps(repository), async (base) => {
    const response = await fetch(`${base}/api/books/${created.id}/cover`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      response.headers.get('cache-control'),
      'private, max-age=31536000, immutable'
    );
  });
});
