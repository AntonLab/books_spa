import type { BookStatus } from './book.ts';
import type { SessionPermissions } from './permission.ts';

// What the viewer may do with a Book or Series, so a page shows only what the
// server would allow. The server refuses the rest regardless. The rules mirror
// it: coAuthorGuard.ts (`any` all, `own` a Co-author, `none` refused earlier by
// requirePermission) and visibility.ts (a Draft for Co-authors and
// Moderators). They are decided from the viewer's matrix scope, so a new Role
// or grant needs no edit here.
//
// isCoAuthor alone gates what a Moderator never does: the byline and adding
// chapters (the matrix gives Moderators no create).

export type WorkKind = 'book' | 'series';

export interface WorkViewer {
  id: number;
  permissions: SessionPermissions;
}

export interface WorkSubject {
  authors: readonly { id: number }[];
  status?: BookStatus; // absent for a Series: never a Draft
}

export interface WorkAccess {
  isCoAuthor: boolean;
  mayEdit: boolean;
  mayLike: boolean;
  mayRead: boolean;
  mayFavorite: boolean;
  mayKeepInLibrary: boolean;
}

export const workAccess = (
  kind: WorkKind,
  viewer: WorkViewer | null | undefined,
  work: WorkSubject
): WorkAccess => {
  const isCoAuthor =
    viewer != null && work.authors.some((author) => author.id === viewer.id);
  const scope =
    viewer?.permissions[kind === 'book' ? 'books' : 'series'].update;
  const mayEdit = scope === 'any' || (scope === 'own' && isCoAuthor);
  const isDraft = work.status === 'draft';
  // A Co-author keeps no own Work as a Favorite or in a Library: the server
  // refuses.
  const mayHoldAsReader = viewer != null && !isCoAuthor;
  return {
    isCoAuthor,
    mayEdit,
    // Signed in, not a Draft, not the viewer's own book.
    mayLike: mayHoldAsReader && !isDraft,
    // A Draft is for its Co-authors and Moderators; anything else is public.
    mayRead: !isDraft || mayEdit,
    // The server keeps a Draft's Favorites but counts and lists none of
    // them, so a star on a Draft would show a count that means nothing.
    // Not for a Co-author either.
    mayFavorite: mayHoldAsReader && !isDraft,
    mayKeepInLibrary: mayHoldAsReader,
  };
};
