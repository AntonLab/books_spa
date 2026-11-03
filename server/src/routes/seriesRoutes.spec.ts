import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from '../repositories/notificationRepository.ts';
import type { SeriesRepository } from '../repositories/seriesRepository.ts';
import { createFakeSeriesRepository } from '../repositories/seriesRepository.fake.testkit.ts';
import type {
  AuthorSummary,
  PublicGenre,
  PublicSeries,
  SeriesDetail,
  Wire,
} from 'shared';
import {
  aWebpImage,
  json,
  put,
  ROLE_COOKIES,
  USER_IDS,
  withApp,
  withAuthenticatedApp,
} from './routeTestKit.testkit.ts';

// Every series in this suite is created by the `author` persona by default —
// only `author` (and `admin`, on update/delete) has anything but `none` on
// series in the matrix — so the "known valid user" the fake repository
// accepts is that persona's id, not an arbitrary constant.
const KNOWN_USER_ID = USER_IDS.author;
const UNOWNED_USER_ID = 999997;
// A book filed under the first series each fake creates, so the unlink route
// has something to take out.
const FILED_BOOK_ID = 40;

const KNOWN_GENRE_ID = 5;
const MISSING_GENRE_ID = 999996;

const GENRES = new Map<number, PublicGenre>([
  [KNOWN_GENRE_ID, { id: KNOWN_GENRE_ID, name: 'Gothic', parent: null }],
]);

// Every persona a fake credit can name, so a response's `authors` carries real
// summaries rather than ids.
const SUMMARIES = new Map<number, AuthorSummary>(
  [KNOWN_USER_ID, USER_IDS.otherAuthor, USER_IDS.user].map((id) => [
    id,
    {
      id,
      login: `persona-${id}`,
      firstName: 'First',
      lastName: `Last${id}`,
      status: 'active',
      avatarUrl: null,
    },
  ])
);

const VIEWER_FAVORITE_ID = 77;

const createFakeRepository = (
  actors: [string, Actor][] = []
): SeriesRepository =>
  createFakeSeriesRepository({
    accounts: SUMMARIES,
    books: new Map([[FILED_BOOK_ID, 1]]),
    genres: GENRES,
    favorites: { count: 3, viewerFavoriteId: VIEWER_FAVORITE_ID },
    library: { inLibrary: true, notInterested: false },
    actors,
  });

// No userId: the first Co-author comes from the session, never the body.
const valid = {
  title: 'A Space Opera',
  description: 'A space opera in three parts',
  tags: ['sci-fi', 'epic'],
};

// Defaults to the author persona: create and update both need `own` or `any`
// scope on series, and `user` has `none` on all three, so AUTH_COOKIE (the
// `user` persona) is not a usable default for a write in this file.
const post = (
  base: string,
  body: unknown,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series`, {
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
  fetch(`${base}/api/series/${id}`, {
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
  fetch(`${base}/api/series/${id}`, {
    method: 'DELETE',
    headers: {
      ...(cookie ? { cookie } : {}),
    },
  });

test('POST creates a series credited to the caller and echoes its tags', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await post(base, valid);
      const body = await json<PublicSeries>(response);

      assert.equal(response.status, 201);
      assert.deepEqual(
        body.authors.map((author) => author.id),
        [KNOWN_USER_ID]
      );
      assert.deepEqual(body.tags, ['sci-fi', 'epic']);
    }
  );
});

test('POST defaults tags to an empty array when omitted', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await post(base, {
        title: 'No Tags Yet',
        description: 'No tags yet',
      });

      assert.equal(response.status, 201);
      assert.deepEqual((await json<PublicSeries>(response)).tags, []);
    }
  );
});

test('POST collapses duplicate tags before storing them', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await post(base, {
        ...valid,
        tags: ['epic', 'epic', 'sci-fi'],
      });

      assert.deepEqual((await json<PublicSeries>(response)).tags, [
        'epic',
        'sci-fi',
      ]);
    }
  );
});

test('POST rejects a missing description with 400', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await post(base, {});

      assert.equal(response.status, 400);
      assert.match(
        (await json<{ error: string }>(response)).error,
        /validation/i
      );
    }
  );
});

// There is no longer a route-level way to reach an "unknown user" 404: userId
// is not client-controlled, and authStubs only ever resolves known personas.
// The repository-level mapping from a rejected FK to NotFoundError is still
// covered directly in seriesRepository.spec.ts.

// As in bookRoutes.spec.ts: the caller is the `author` persona, which
// holds `none` on every genres action — choosing a Genre rides on the series'
// own create grant.
test('POST files a series under a genre, and leaves it without one when genreId is absent', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const filed = await post(base, { ...valid, genreId: KNOWN_GENRE_ID });
      const without = await post(base, valid);

      assert.equal(filed.status, 201);
      assert.deepEqual((await json<PublicSeries>(filed)).genre, {
        id: KNOWN_GENRE_ID,
        name: 'Gothic',
        parent: null,
      });
      assert.equal((await json<PublicSeries>(without)).genre, null);
    }
  );
});

// Choosing a Genre rides on the series' own create/update grant, so
// nothing extra is checked — but an id that names no Genre is a 400. The
// create path's body is asserted, not just its status: that is where it
// differs from a zod ValidationError, which carries `details`.
test('a genreId that names no genre is 400 on create and on update', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(await post(base, valid));

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
    }
  );
});

test('PATCH without genreId keeps the genre, and an explicit null clears it', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(
        await post(base, { ...valid, genreId: KNOWN_GENRE_ID })
      );

      const renamed = await json<PublicSeries>(
        await patch(base, created.id, { title: 'Renamed' })
      );
      assert.equal(renamed.genre?.id, KNOWN_GENRE_ID);

      const cleared = await json<PublicSeries>(
        await patch(base, created.id, { genreId: null })
      );
      assert.equal(cleared.genre, null);
    }
  );
});

test('GET list filters by genre', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      await post(base, { ...valid, genreId: KNOWN_GENRE_ID });
      await post(base, valid);

      const inGenre = await json<{ total: number }>(
        await fetch(`${base}/api/series?genreId=${KNOWN_GENRE_ID}`)
      );
      const inMissing = await json<{ total: number }>(
        await fetch(`${base}/api/series?genreId=${MISSING_GENRE_ID}`)
      );

      assert.equal(inGenre.total, 1);
      assert.equal(inMissing.total, 0);
    }
  );
});

test('GET list with favoritedBy=me is 401 for a Guest and 400 for another value', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const guest = await fetch(`${base}/api/series?favoritedBy=me`);
      const bad = await fetch(`${base}/api/series?favoritedBy=you`);

      assert.equal(guest.status, 401);
      assert.equal(bad.status, 400);
    }
  );
});

test('GET list takes published=true and refuses any other value with 400', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal(
        (await fetch(`${base}/api/series?published=true`)).status,
        200
      );
      for (const bad of ['false', '1', '']) {
        const response = await fetch(`${base}/api/series?published=${bad}`);
        assert.equal(response.status, 400, bad);
      }
    }
  );
});

test('GET list takes a known sort and refuses any other with 400', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      for (const sort of ['popular', 'new', 'updated']) {
        const response = await fetch(
          `${base}/api/series?published=true&sort=${sort}`
        );
        assert.equal(response.status, 200, sort);
      }
      assert.equal((await fetch(`${base}/api/series?sort=oldest`)).status, 400);
    }
  );
});

test('GET list returns items with the paging envelope', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      await post(base, valid);
      const response = await fetch(`${base}/api/series`);
      const body = await json<{
        total: number;
        limit: number;
        offset: number;
        items: unknown[];
      }>(response);

      assert.equal(response.status, 200);
      assert.deepEqual(
        { total: body.total, limit: body.limit, offset: body.offset },
        { total: 1, limit: 20, offset: 0 }
      );
      assert.equal(body.items.length, 1);
    }
  );
});

test('GET list filters by tag and by owner', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      await post(base, valid);
      await post(base, {
        ...valid,
        description: 'Standalone',
        tags: ['drama'],
      });

      const byTag = await json<{ total: number }>(
        await fetch(`${base}/api/series?tag=drama`)
      );
      const byUser = await json<{ total: number }>(
        await fetch(`${base}/api/series?userId=${KNOWN_USER_ID}`)
      );
      const byOther = await json<{ total: number }>(
        await fetch(`${base}/api/series?userId=${UNOWNED_USER_ID}`)
      );

      assert.equal(byTag.total, 1);
      assert.equal(byUser.total, 2);
      assert.equal(byOther.total, 0);
    }
  );
});

test('GET by id returns 404 for a missing record', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal((await fetch(`${base}/api/series/999`)).status, 404);
    }
  );
});

test('GET by id reports the favorite count, and the viewer own favorite only when signed in', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      await post(base, valid);

      const anonymous = await fetch(`${base}/api/series/1`);
      const signedIn = await fetch(`${base}/api/series/1`, {
        headers: { cookie: ROLE_COOKIES.user },
      });

      assert.equal(anonymous.status, 200);
      const guestBody = await json<Wire<SeriesDetail>>(anonymous);
      assert.equal(guestBody.title, valid.title);
      assert.equal(guestBody.favoriteCount, 3);
      assert.equal(guestBody.viewerFavoriteId, null);
      assert.equal(
        (await json<Wire<SeriesDetail>>(signedIn)).viewerFavoriteId,
        VIEWER_FAVORITE_ID
      );
    }
  );
});

test('detail carries viewerLibrary for a signed-in viewer and null for a Guest', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      await post(base, valid);

      const anonymous = await fetch(`${base}/api/series/1`);
      const signedIn = await fetch(`${base}/api/series/1`, {
        headers: { cookie: ROLE_COOKIES.user },
      });

      assert.equal(
        (await json<Wire<SeriesDetail>>(anonymous)).viewerLibrary,
        null
      );
      assert.deepEqual(
        (await json<Wire<SeriesDetail>>(signedIn)).viewerLibrary,
        {
          inLibrary: true,
          notInterested: false,
        }
      );
    }
  );
});

test('GET by id rejects a non-numeric id with 400', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal((await fetch(`${base}/api/series/abc`)).status, 400);
    }
  );
});

test('PATCH replaces tags but leaves them alone when omitted', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(await post(base, valid));

      const retagged = await json<PublicSeries>(
        await patch(base, created.id, { tags: ['drama'] })
      );
      assert.deepEqual(retagged.tags, ['drama']);

      const renamed = await json<PublicSeries>(
        await patch(base, created.id, { description: 'Rewritten' })
      );
      assert.equal(renamed.description, 'Rewritten');
      assert.deepEqual(renamed.tags, ['drama']);
    }
  );
});

test('PATCH ignores userId rather than re-crediting the series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(await post(base, valid));
      const response = await patch(base, created.id, {
        userId: UNOWNED_USER_ID,
        description: 'Rewritten',
      });

      assert.equal(response.status, 200);
      assert.deepEqual(
        (await json<PublicSeries>(response)).authors.map((author) => author.id),
        [KNOWN_USER_ID]
      );
    }
  );
});

test('PATCH with an empty body is rejected with 400', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(await post(base, valid));

      assert.equal((await patch(base, created.id, {})).status, 400);
    }
  );
});

test('PATCH on a missing record is a 404', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal((await patch(base, 999, { tags: [] })).status, 404);
    }
  );
});

test('DELETE removes the series, then reports 404 on a second attempt', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(await post(base, valid));

      const first = await remove(base, created.id);
      const second = await remove(base, created.id);

      assert.equal(first.status, 204);
      assert.equal(second.status, 404);
    }
  );
});

test('POST without a session is 401', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await post(base, valid, null)).status, 401);
  });
});

test('PATCH without a session is 401', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await patch(base, 1, { tags: [] }, null)).status, 401);
  });
});

test('DELETE without a session is 401', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await remove(base, 1, null)).status, 401);
  });
});

test('GET stays public', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await fetch(`${base}/api/series`)).status, 200);
  });
});

// --- The permission matrix: who may create, edit and delete a series. ---

test('an author creates a series and a plain user may not', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal((await post(base, valid, ROLE_COOKIES.author)).status, 201);
      assert.equal((await post(base, valid, ROLE_COOKIES.user)).status, 403);
    }
  );
});

test('an admin may not create a series but may delete any', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      assert.equal((await post(base, valid, ROLE_COOKIES.admin)).status, 403);

      const created = await json<PublicSeries>(
        await post(base, valid, ROLE_COOKIES.author)
      );
      assert.equal(
        (await remove(base, created.id, ROLE_COOKIES.admin)).status,
        204
      );
    }
  );
});

test('an author may not edit another author series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(
        await post(base, valid, ROLE_COOKIES.author)
      );

      const response = await patch(
        base,
        created.id,
        { description: 'Hijacked' },
        ROLE_COOKIES.otherAuthor
      );
      assert.equal(response.status, 403);
    }
  );
});

test('an author may not delete another author series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(
        await post(base, valid, ROLE_COOKIES.author)
      );

      const response = await remove(base, created.id, ROLE_COOKIES.otherAuthor);
      assert.equal(response.status, 403);

      // The row must survive the refused attempt, not just the status code.
      const stillThere = await fetch(`${base}/api/series/${created.id}`);
      assert.equal(stillThere.status, 200);
    }
  );
});

test('an admin may edit another author series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const created = await json<PublicSeries>(
        await post(base, valid, ROLE_COOKIES.author)
      );

      const response = await patch(
        base,
        created.id,
        { description: 'Moderated' },
        ROLE_COOKIES.admin
      );
      assert.equal(response.status, 200);
      assert.equal(
        (await json<PublicSeries>(response)).description,
        'Moderated'
      );
    }
  );
});

test('an anonymous create is 401 and GET stays public', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await post(base, valid, null)).status, 401);
    assert.equal((await fetch(`${base}/api/series`)).status, 200);
  });
});

// --- Co-authors: every one of them may touch the series (ADR-0005). ---

const addCoAuthor = (
  base: string,
  seriesId: number,
  userId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${seriesId}/co-authors`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ userId }),
  });

const removeCoAuthor = (
  base: string,
  seriesId: number,
  userId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${seriesId}/co-authors/${userId}`, {
    method: 'DELETE',
    headers: { ...(cookie ? { cookie } : {}) },
  });

const removeBook = (
  base: string,
  seriesId: number,
  bookId: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${seriesId}/books/${bookId}`, {
    method: 'DELETE',
    headers: { ...(cookie ? { cookie } : {}) },
  });

test('a co-author credited by the author may edit the series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));

      const added = await addCoAuthor(base, id, USER_IDS.otherAuthor);
      assert.equal(added.status, 200);
      assert.deepEqual(
        (await json<PublicSeries>(added)).authors.map((author) => author.id),
        [KNOWN_USER_ID, USER_IDS.otherAuthor]
      );

      const response = await patch(
        base,
        id,
        { description: 'Co-written' },
        ROLE_COOKIES.otherAuthor
      );
      assert.equal(response.status, 200);
    }
  );
});

test('a co-author may remove another co-author of the series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));
      await addCoAuthor(base, id, USER_IDS.otherAuthor);

      const response = await removeCoAuthor(
        base,
        id,
        KNOWN_USER_ID,
        ROLE_COOKIES.otherAuthor
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        (await json<PublicSeries>(response)).authors.map((a) => a.id),
        [USER_IDS.otherAuthor]
      );
    }
  );
});

test('a series co-author who is no longer an author may still leave', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));
      await addCoAuthor(base, id, USER_IDS.user);

      const response = await removeCoAuthor(
        base,
        id,
        USER_IDS.user,
        ROLE_COOKIES.user
      );
      assert.equal(response.status, 200);
    }
  );
});

test('a moderator may not change who is credited on a series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));

      for (const cookie of [ROLE_COOKIES.admin, ROLE_COOKIES.superadmin]) {
        assert.equal(
          (await addCoAuthor(base, id, USER_IDS.otherAuthor, cookie)).status,
          403
        );
        assert.equal(
          (await removeCoAuthor(base, id, KNOWN_USER_ID, cookie)).status,
          403
        );
      }
    }
  );
});

test('changing series co-authors without a session is 401', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    assert.equal((await addCoAuthor(base, 1, 2, null)).status, 401);
    assert.equal((await removeCoAuthor(base, 1, 2, null)).status, 401);
  });
});

// --- Taking a book out of a series from the series' side. ---

test('a series co-author takes a book out of the series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));
      await addCoAuthor(base, id, USER_IDS.otherAuthor);

      const response = await removeBook(
        base,
        id,
        FILED_BOOK_ID,
        ROLE_COOKIES.otherAuthor
      );
      assert.equal(response.status, 204);
      // Gone from the series now, so a second attempt has nothing to unlink.
      assert.equal((await removeBook(base, id, FILED_BOOK_ID)).status, 404);
    }
  );
});

test('a moderator may take a book out of any series', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));

      const response = await removeBook(
        base,
        id,
        FILED_BOOK_ID,
        ROLE_COOKIES.admin
      );
      assert.equal(response.status, 204);
    }
  );
});

test('an author who is not credited on the series may not take a book out', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));

      assert.equal(
        (await removeBook(base, id, FILED_BOOK_ID, ROLE_COOKIES.otherAuthor))
          .status,
        403
      );
      assert.equal((await removeBook(base, 999, FILED_BOOK_ID)).status, 404);
      assert.equal(
        (await removeBook(base, id, FILED_BOOK_ID, null)).status,
        401
      );
    }
  );
});

// --- Notifications name who acted, so the routes must say who that was. ---

test('series credit changes and deletes are made as the signed-in caller', async () => {
  const actors: [string, Actor][] = [];
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository(actors) },
    async (base) => {
      const { id } = await json<PublicSeries>(await post(base, valid));
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

// --- A Series Cover, uploaded, replaced, removed and served. ---

const putCover = (
  base: string,
  id: number,
  body: Buffer | string,
  contentType = 'image/webp',
  cookie: string | null = ROLE_COOKIES.author
) => {
  const url = `${base}/api/series/${id}/cover`;
  return contentType === 'image/webp' && Buffer.isBuffer(body)
    ? put(url, cookie ?? undefined, body)
    : fetch(url, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          ...(cookie ? { cookie } : {}),
        },
        body,
      });
};

const deleteCover = (
  base: string,
  id: number,
  cookie: string | null = ROLE_COOKIES.author
) =>
  fetch(`${base}/api/series/${id}/cover`, {
    method: 'DELETE',
    headers: cookie ? { cookie } : {},
  });

test('PUT /api/series/:id/cover replaces the cover and answers with the updated series, its coverUrl version changing', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const put = (image: Buffer) => putCover(base, created.id, image);
    const first = await json<PublicSeries>(await put(await aWebpImage()));
    assert.match(
      first.coverUrl ?? '',
      new RegExp(`^/api/series/${created.id}/cover\\?v=\\d+$`)
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await json<PublicSeries>(
      await put(await aWebpImage(200, 300))
    );
    assert.notEqual(second.coverUrl, first.coverUrl);
  });
});

test('PUT /api/series/:id/cover answers 401 with no session', async () => {
  await withApp({ seriesRepository: createFakeRepository() }, async (base) => {
    const response = await putCover(
      base,
      1,
      await aWebpImage(),
      undefined,
      null
    );
    assert.equal(response.status, 401);
  });
});

test('PUT /api/series/:id/cover answers 404 before 403 for a series that does not exist', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await putCover(base, 999999, await aWebpImage());
      assert.equal(response.status, 404);
      assert.match((await json<{ error: string }>(response)).error, /^Series /);
    }
  );
});

test('PUT /api/series/:id/cover answers 415 for an unaccepted content type before looking the series up', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await putCover(
        base,
        999999,
        'not an image',
        'text/plain'
      );
      assert.equal(response.status, 415);
    }
  );
});

test('PUT /api/series/:id/cover answers 403 for a signed-in author who does not co-author the series', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({
    userId: USER_IDS.otherAuthor,
    ...valid,
  });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(base, created.id, await aWebpImage());
    assert.equal(response.status, 403);
  });
});

test('PUT /api/series/:id/cover answers 413 for a body over 2 MiB', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(
      base,
      created.id,
      Buffer.alloc(2 * 1024 * 1024 + 1)
    );
    assert.equal(response.status, 413);
  });
});

test('PUT /api/series/:id/cover answers 415 for an unaccepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(
      base,
      created.id,
      'not an image',
      'text/plain'
    );
    assert.equal(response.status, 415);
  });
});

test('PUT /api/series/:id/cover answers 400 for bytes that are not a real image, even under an accepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(
      base,
      created.id,
      Buffer.from('not a real png'),
      'image/png'
    );
    assert.equal(response.status, 400);
  });
});

test('PUT /api/series/:id/cover answers 400 for an empty body, even under an accepted content type', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(
      base,
      created.id,
      Buffer.alloc(0),
      'image/png'
    );
    assert.equal(response.status, 400);
  });
});

test('PUT /api/series/:id/cover answers 404 for a missing series under `any` scope (a Moderator) before reading the image', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      // Bytes sharp refuses with a 400, so a 404 proves the Series was looked
      // up before processCoverImage ran.
      const response = await putCover(
        base,
        999999,
        Buffer.from('not a real png'),
        'image/png',
        ROLE_COOKIES.admin
      );
      assert.equal(response.status, 404);
    }
  );
});

test('PUT /api/series/:id/cover answers 200 for a Moderator on a series they do not co-author', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    const response = await putCover(
      base,
      created.id,
      await aWebpImage(),
      'image/webp',
      ROLE_COOKIES.admin
    );
    assert.equal(response.status, 200);
  });
});

test('DELETE /api/series/:id/cover answers 401, then 404, then 403, in that order, and 204 on success — including with no cover', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  const strangers = await repository.create({
    userId: USER_IDS.otherAuthor,
    ...valid,
  });

  await withApp({ seriesRepository: repository }, async (base) => {
    assert.equal((await deleteCover(base, created.id, null)).status, 401);
  });

  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    assert.equal((await deleteCover(base, 999999)).status, 404);
    assert.equal((await deleteCover(base, strangers.id)).status, 403);
    assert.equal((await deleteCover(base, created.id)).status, 204);

    await putCover(base, created.id, await aWebpImage());
    assert.equal((await deleteCover(base, created.id)).status, 204);
  });
});

test('DELETE /api/series/:id/cover answers 404 for a missing series even under `any` scope (a Moderator)', async () => {
  await withAuthenticatedApp(
    { seriesRepository: createFakeRepository() },
    async (base) => {
      const response = await deleteCover(base, 999999, ROLE_COOKIES.admin);
      assert.equal(response.status, 404);
    }
  );
});

test('GET /api/series/:id/cover answers 404 for a series with no cover, and for a missing series', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withApp({ seriesRepository: repository }, async (base) => {
    assert.equal(
      (await fetch(`${base}/api/series/${created.id}/cover`)).status,
      404
    );
    assert.equal((await fetch(`${base}/api/series/999999/cover`)).status, 404);
  });
});

test('GET /api/series/:id/cover serves the WebP bytes with the versioned cache headers, publicly (a guest included)', async () => {
  const repository = createFakeRepository();
  const created = await repository.create({ userId: KNOWN_USER_ID, ...valid });
  await withAuthenticatedApp({ seriesRepository: repository }, async (base) => {
    await putCover(base, created.id, await aWebpImage());
  });
  await withApp({ seriesRepository: repository }, async (base) => {
    const response = await fetch(`${base}/api/series/${created.id}/cover`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      response.headers.get('cache-control'),
      'private, max-age=31536000, immutable'
    );
  });
});
