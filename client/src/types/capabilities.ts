import type { BookStatus } from 'shared';
import { workAccess } from 'shared';
import type { SessionUser } from './api';

// What the viewer may do with a Book or Series, so a page shows only what the
// server would allow. The rules live in shared/src/workAccess.ts; these
// wrappers only pick the fields each kind of page uses.
//
// isCoAuthor alone gates what a Moderator never does: the byline and adding
// chapters (the matrix gives Moderators no create).

type Session = SessionUser | null | undefined;

interface Credited {
  authors: readonly { id: number }[];
}

export const seriesCapabilities = (series: Credited, session: Session) => {
  const { isCoAuthor, mayEdit, mayFavorite, mayKeepInLibrary } = workAccess(
    'series',
    session,
    series
  );
  return { isCoAuthor, mayEdit, mayFavorite, mayKeepInLibrary };
};

export const readingListCapabilities = (
  list: { owner: { id: number } },
  session: Session
) => {
  const isOwner = session != null && list.owner.id === session.id;
  return {
    isOwner,
    // No Moderator override: a list is its owner's.
    mayEdit: isOwner,
    // Any signed-in Account but the owner, who already has it.
    mayCopy: session != null && !isOwner,
  };
};

export const mayAddBookToReadingList = (
  book: { status: BookStatus },
  session: Session
) => session != null && book.status !== 'draft';

// bookCount covers Published Books only, so it equals the server's rule for
// what a Series adds.
export const mayAddSeriesToReadingList = (
  series: { bookCount: number },
  session: Session
) => session != null && series.bookCount > 0;

export const bookCapabilities = (
  book: Credited & { status: BookStatus },
  session: Session
) => workAccess('book', session, book);
