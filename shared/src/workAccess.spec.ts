import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, MODULES } from './permission.ts';
import type { PermissionScope, SessionPermissions } from './permission.ts';
import { workAccess } from './workAccess.ts';
import type { WorkViewer } from './workAccess.ts';

const permissionsWith = (
  books: PermissionScope,
  series: PermissionScope
): SessionPermissions => {
  const permissions = Object.fromEntries(
    MODULES.map((module) => [
      module,
      Object.fromEntries(ACTIONS.map((action) => [action, 'none'])),
    ])
  ) as SessionPermissions;
  permissions.books.update = books;
  permissions.series.update = series;
  return permissions;
};

const viewer = (
  id: number,
  books: PermissionScope,
  series: PermissionScope = books
): WorkViewer => ({ id, permissions: permissionsWith(books, series) });

const CO_AUTHOR = viewer(1, 'own');
const READER = viewer(2, 'none');
const MODERATOR = viewer(3, 'any');
const WORK = { authors: [{ id: 1 }] };

// viewer, status, isCoAuthor, mayEdit, mayLike, mayRead, mayFavorite, mayKeepInLibrary
const BOOK_CASES = [
  ['a Guest', null, 'complete', false, false, false, true, false, false],
  ['a Guest', null, 'draft', false, false, false, false, false, false],
  ['loading', undefined, 'complete', false, false, false, true, false, false],
  ['a Co-author', CO_AUTHOR, 'complete', true, true, false, true, false, false],
  ['a Co-author', CO_AUTHOR, 'draft', true, true, false, true, false, false],
  ['a reader', READER, 'in_progress', false, false, true, true, true, true],
  ['a reader', READER, 'draft', false, false, false, false, false, true],
  [
    'own, not credited',
    viewer(2, 'own'),
    'complete',
    false,
    false,
    true,
    true,
    true,
    true,
  ],
  [
    'any, not credited',
    MODERATOR,
    'complete',
    false,
    true,
    true,
    true,
    true,
    true,
  ],
  [
    'any, not credited',
    MODERATOR,
    'draft',
    false,
    true,
    false,
    true,
    false,
    true,
  ],
  [
    'any and credited',
    viewer(1, 'any'),
    'complete',
    true,
    true,
    false,
    true,
    false,
    false,
  ],
  [
    'credited, scope none',
    viewer(1, 'none'),
    'draft',
    true,
    false,
    false,
    false,
    false,
    false,
  ],
] as const;

for (const [
  label,
  who,
  status,
  isCoAuthor,
  mayEdit,
  mayLike,
  mayRead,
  mayFavorite,
  mayKeepInLibrary,
] of BOOK_CASES) {
  test(`a book: ${label} on a ${status} book`, () => {
    assert.deepEqual(workAccess('book', who, { ...WORK, status }), {
      isCoAuthor,
      mayEdit,
      mayLike,
      mayRead,
      mayFavorite,
      mayKeepInLibrary,
    });
  });
}

test('a series is edited by its own grant, not the books grant', () => {
  assert.equal(
    workAccess('series', viewer(3, 'any', 'none'), WORK).mayEdit,
    false
  );
  assert.equal(
    workAccess('series', viewer(3, 'none', 'any'), WORK).mayEdit,
    true
  );
  assert.equal(
    workAccess('series', viewer(1, 'none', 'own'), WORK).mayEdit,
    true
  );
  assert.equal(
    workAccess('book', viewer(3, 'none', 'any'), WORK).mayEdit,
    false
  );
});

test('a series has no Draft: a reader may read, favorite and keep it', () => {
  const access = workAccess('series', READER, WORK);
  assert.equal(access.mayRead, true);
  assert.equal(access.mayFavorite, true);
  assert.equal(access.mayKeepInLibrary, true);
});

test('credits: none, one match and a second Co-author', () => {
  const as = (id: number, authors: { id: number }[]) =>
    workAccess('book', viewer(id, 'own'), { authors, status: 'complete' });
  assert.equal(as(1, []).isCoAuthor, false);
  assert.equal(as(1, []).mayEdit, false);
  assert.equal(as(2, [{ id: 1 }, { id: 2 }]).isCoAuthor, true);
  assert.equal(as(2, [{ id: 1 }, { id: 2 }]).mayEdit, true);
});

test('scope none never edits, whoever the viewer is', () => {
  for (const kind of ['book', 'series'] as const) {
    for (const id of [0, 1, 2, 1_000_000]) {
      assert.equal(
        workAccess(kind, viewer(id, 'none'), { ...WORK, status: 'draft' })
          .mayEdit,
        false,
        `${kind} ${id}`
      );
    }
  }
});
