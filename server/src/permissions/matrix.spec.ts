import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrixRows } from './matrix.ts';
import { ACTIONS, MODULES, ROLES } from '../types/permission.ts';

const rows = buildMatrixRows();

const scope = (role: string, module: string, action: string) =>
  rows.find(
    (row) => row.role === role && row.module === module && row.action === action
  )?.scope;

test('only moderators read the user directory', () => {
  for (const role of ['guest', 'user', 'author']) {
    assert.equal(scope(role, 'users', 'read'), 'none', role);
  }
  for (const role of ['admin', 'superadmin']) {
    assert.equal(scope(role, 'users', 'read'), 'any', role);
  }
  // Editing and deleting one's own row is untouched.
  assert.equal(scope('user', 'users', 'update'), 'own');
  assert.equal(scope('author', 'users', 'delete'), 'own');
});

test('the matrix covers every role, module and action exactly once', () => {
  assert.equal(rows.length, ROLES.length * MODULES.length * ACTIONS.length);

  const seen = new Set(
    rows.map((row) => `${row.role}/${row.module}/${row.action}`)
  );
  assert.equal(seen.size, rows.length);
});

// The invariant that stops a bad seed from locking everyone out. Cheaper than
// carving an exception for superadmin into the enforcement path, and it fails
// exactly when the seed is wrong.
test('superadmin has any on everything except creating content, rewriting comments or likes, and favorites', () => {
  for (const module of MODULES) {
    // Pinned on its own below: favorites follow the everyone-alike rule.
    if (module === 'favorites') continue;
    for (const action of ACTIONS) {
      const createsContent =
        action === 'create' &&
        (module === 'books' || module === 'series' || module === 'chapters');
      const rewritesReaction =
        action === 'update' && (module === 'comments' || module === 'likes');

      let expected = 'any';
      if (createsContent) expected = 'none';
      else if (rewritesReaction) expected = 'own';

      assert.equal(
        scope('superadmin', module, action),
        expected,
        `superadmin/${module}/${action}`
      );
    }
  }
});

test("moderators remove comments and likes but never rewrite someone else's", () => {
  for (const role of ['admin', 'superadmin']) {
    assert.equal(scope(role, 'comments', 'update'), 'own', `${role} comments`);
    assert.equal(scope(role, 'comments', 'delete'), 'any', `${role} comments`);
    assert.equal(scope(role, 'likes', 'update'), 'own', `${role} likes`);
    assert.equal(scope(role, 'likes', 'delete'), 'any', `${role} likes`);
  }
});

test('guest reads the public catalogue and nothing else', () => {
  assert.equal(scope('guest', 'books', 'read'), 'any');
  assert.equal(scope('guest', 'series', 'read'), 'any');
  assert.equal(scope('guest', 'chapters', 'read'), 'any');
  assert.equal(scope('guest', 'comments', 'read'), 'any');
  assert.equal(scope('guest', 'likes', 'read'), 'any');
  // PublicUser carries an email; an open list would be a scrapeable directory.
  assert.equal(scope('guest', 'users', 'read'), 'none');
  assert.equal(scope('guest', 'books', 'create'), 'none');
});

test('a plain user may comment but not author', () => {
  assert.equal(scope('user', 'comments', 'create'), 'own');
  assert.equal(scope('user', 'comments', 'update'), 'own');
  assert.equal(scope('user', 'books', 'create'), 'none');
});

test('an author writes only their own content', () => {
  assert.equal(scope('author', 'books', 'create'), 'own');
  assert.equal(scope('author', 'books', 'update'), 'own');
  assert.equal(scope('author', 'books', 'delete'), 'own');
  assert.equal(scope('author', 'chapters', 'update'), 'own');
});

test('an admin moderates but does not author', () => {
  assert.equal(scope('admin', 'books', 'update'), 'any');
  assert.equal(scope('admin', 'books', 'delete'), 'any');
  assert.equal(scope('admin', 'series', 'update'), 'any');
  assert.equal(scope('admin', 'chapters', 'delete'), 'any');
  assert.equal(scope('admin', 'comments', 'delete'), 'any');
  // Without this, admin would inherit USER_GRANTS.likes verbatim — `own` on
  // delete — and could not act on a reported like any more than a plain user
  // could.
  assert.equal(scope('admin', 'likes', 'delete'), 'any');
  assert.equal(scope('admin', 'reports', 'update'), 'any');
  // The one deliberate break in the accumulation: admins moderate, they do not
  // write books.
  assert.equal(scope('admin', 'books', 'create'), 'none');
  assert.equal(scope('admin', 'series', 'create'), 'none');
  assert.equal(scope('admin', 'chapters', 'create'), 'none');
});

// Pins the copy in client/src/test/session.ts permissionsOf: moderators `any`,
// author `own`, everyone else `none`.
test('books and series update scope per role matches the client test fixture', () => {
  const expected = {
    guest: 'none',
    user: 'none',
    author: 'own',
    admin: 'any',
    superadmin: 'any',
  };
  for (const [role, want] of Object.entries(expected)) {
    for (const module of ['books', 'series']) {
      assert.equal(scope(role, module, 'update'), want, `${role} ${module}`);
    }
  }
});

test('a user may flip their own like, which the API exposes as PATCH /likes/:id', () => {
  // likeRoutes has always had a PATCH — it is how a like becomes a dislike.
  // Without this grant the route is reachable by superadmin alone, which is a
  // gap rather than a policy: nobody can change their own reaction.
  assert.equal(scope('user', 'likes', 'update'), 'own');
  assert.equal(scope('author', 'likes', 'update'), 'own');
});

// `own` is only honoured where a controller compares owners, and that happens
// on update and delete alone: no list or get-by-id handler reads
// req.permissionScope. A `read: own` grant would therefore behave exactly like
// `any` — every row, not just the caller's — while claiming otherwise. Teach a
// read handler to filter by owner before letting one in.
test('no role is granted own on read, which no read handler would honour', () => {
  const ownReads = rows.filter(
    (row) => row.action === 'read' && row.scope === 'own'
  );

  assert.deepEqual(ownReads, []);
});

// A Genre has no Owner, so no grant here is `own`: either a role may keep
// the list or it may not. Everyone reads it, guests included, because the
// header's Genres menu renders before anyone signs in.
test('everyone reads genres and only admins keep the list', () => {
  for (const role of ['guest', 'user', 'author']) {
    assert.equal(scope(role, 'genres', 'read'), 'any', `${role} read`);
    for (const action of ['create', 'update', 'delete']) {
      assert.equal(scope(role, 'genres', action), 'none', `${role} ${action}`);
    }
  }

  for (const role of ['admin', 'superadmin']) {
    for (const action of ACTIONS) {
      assert.equal(scope(role, 'genres', action), 'any', `${role} ${action}`);
    }
  }
});

// A Favorite is private to its Account: every signed-in role adds and removes
// its own, nobody reads or edits anyone else's — a Moderator included, since
// there is nothing to moderate in a private bookmark. The lists sit behind
// requireAuth and read the session's rows only, so no role needs `read`.
test('every signed-in role adds and removes its own favorites, and nothing more', () => {
  for (const role of ['user', 'author', 'admin', 'superadmin']) {
    assert.equal(scope(role, 'favorites', 'create'), 'own', `${role} create`);
    assert.equal(scope(role, 'favorites', 'delete'), 'own', `${role} delete`);
    assert.equal(scope(role, 'favorites', 'read'), 'none', `${role} read`);
    assert.equal(scope(role, 'favorites', 'update'), 'none', `${role} update`);
  }
});

test('a guest has no favorites grant at all', () => {
  for (const action of ACTIONS) {
    assert.equal(scope('guest', 'favorites', action), 'none', action);
  }
});
