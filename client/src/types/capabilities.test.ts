import type { BookStatus } from 'shared';
import {
  bookCapabilities,
  mayAddBookToReadingList,
  mayAddSeriesToReadingList,
  readingListCapabilities,
  seriesCapabilities,
} from './capabilities';
import { sessionOf } from '@/test/session';
import type { PublicUser, SessionUser } from './api';

const account = (id: number, role: PublicUser['role']): SessionUser =>
  sessionOf({
    id,
    login: `account${id}`,
    email: `account${id}@example.com`,
    firstName: 'Test',
    lastName: 'Account',
    role,
    status: 'active',
    avatarUrl: null,
    about: '',
    showLastSeen: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

const COAUTHOR = account(1, 'author');
const STRANGER = account(2, 'author');
const ADMIN = account(3, 'admin');
const SUPERADMIN = account(4, 'superadmin');

const book = (status: BookStatus) => ({ status, authors: [{ id: 1 }] });

describe('bookCapabilities', () => {
  it.each([
    // viewer, status, isCoAuthor, mayEdit, mayLike, mayRead, mayFavorite
    ['a Guest', null, 'complete', false, false, false, true, false],
    ['a Guest', null, 'draft', false, false, false, false, false],
    ['a Co-author', COAUTHOR, 'complete', true, true, false, true, false],
    ['a Co-author', COAUTHOR, 'draft', true, true, false, true, false],
    ['a stranger', STRANGER, 'in_progress', false, false, true, true, true],
    ['a stranger', STRANGER, 'draft', false, false, false, false, false],
    ['an admin', ADMIN, 'complete', false, true, true, true, true],
    ['an admin', ADMIN, 'draft', false, true, false, true, false],
    ['a superadmin', SUPERADMIN, 'draft', false, true, false, true, false],
  ] as const)(
    '%s on a %s book',
    (
      _name,
      session,
      status,
      isCoAuthor,
      mayEdit,
      mayLike,
      mayRead,
      mayFavorite
    ) => {
      // toMatchObject: mayKeepInLibrary has its own table below.
      expect(bookCapabilities(book(status), session)).toMatchObject({
        isCoAuthor,
        mayEdit,
        mayLike,
        mayRead,
        mayFavorite,
      });
    }
  );

  it('treats a session still loading as a Guest', () => {
    expect(bookCapabilities(book('complete'), undefined).mayLike).toBe(false);
  });
});

describe('bookCapabilities mayKeepInLibrary', () => {
  it.each([
    ['a Guest', null, 'draft', false],
    ['a stranger on a complete book', STRANGER, 'complete', true],
    ['a Co-author on a draft', COAUTHOR, 'draft', false],
    ['a Co-author on a complete book', COAUTHOR, 'complete', false],
    ['an admin', ADMIN, 'complete', true],
  ] as const)('is as expected for %s', (_who, session, status, expected) => {
    expect(bookCapabilities(book(status), session).mayKeepInLibrary).toBe(
      expected
    );
  });
});

describe('readingListCapabilities', () => {
  const list = { owner: { id: 1 } };
  it.each([
    ['a Guest', null, false, false, false],
    ['the owner', COAUTHOR, true, true, false],
    ['another Account', STRANGER, false, false, true],
    ['an admin', ADMIN, false, false, true],
  ] as const)(
    '%s: isOwner, mayEdit, mayCopy',
    (_n, session, isOwner, mayEdit, mayCopy) => {
      expect(readingListCapabilities(list, session)).toEqual({
        isOwner,
        mayEdit,
        mayCopy,
      });
    }
  );
});

describe('what may be added to a Reading list', () => {
  it.each([
    ['a Guest', null, 'complete', false],
    ['a signed-in Account', STRANGER, 'complete', true],
    ['a signed-in Account', STRANGER, 'draft', false],
  ] as const)('%s on a %s Book: %s', (_n, session, status, expected) => {
    expect(mayAddBookToReadingList({ status }, session)).toBe(expected);
  });
  it.each([
    ['a Guest', null, 2, false],
    ['a signed-in Account', STRANGER, 2, true],
    ['a signed-in Account', STRANGER, 0, false],
  ] as const)(
    '%s on a Series with %s Published Books: %s',
    (_n, session, bookCount, expected) => {
      expect(mayAddSeriesToReadingList({ bookCount }, session)).toBe(expected);
    }
  );
});

describe('seriesCapabilities', () => {
  const series = { authors: [{ id: 1 }] };

  it.each([
    ['a Guest', null, false, false, false],
    ['a Co-author', COAUTHOR, true, true, false],
    ['a stranger', STRANGER, false, false, true],
    ['an admin', ADMIN, false, true, true],
  ] as const)('%s', (_name, session, isCoAuthor, mayEdit, mayFavorite) => {
    // The Library and the Favorite share one rule: no Co-author, a Guest none.
    expect(seriesCapabilities(series, session)).toEqual({
      isCoAuthor,
      mayEdit,
      mayFavorite,
      mayKeepInLibrary: mayFavorite,
    });
  });
});
