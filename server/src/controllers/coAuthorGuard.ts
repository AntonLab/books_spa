import type { Request } from 'express';
import { scopeFor } from '../permissions/permissionStore.ts';
import type { BookRepository } from '../repositories/bookRepository.ts';
import type { ChapterRepository } from '../repositories/chapterRepository.ts';
import type { IllustrationRepository } from '../repositories/illustrationRepository.ts';
import type { SeriesRepository } from '../repositories/seriesRepository.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../types/errors.ts';

// The other half of enforcement for Books, Series, Chapters and Illustrations.
// requirePermission already refused `none`; `own` has to look at the row —
// which is why this cannot live in the middleware, where the row is not
// loaded yet.
//
// `own` means "one of the work's Co-authors": a work has no single owner, and
// every Co-author holds the same rights over it (ADR-0005).
//
// Every check resolves the row first, under every scope, so a missing one is
// 404 before 403 (a refusal cannot be used to probe which ids exist) and
// before a handler spends work on the body. createCoAuthorGuard owns that
// order: it resolves the row itself from a ref, so a caller cannot skip it.

// The refusal for editing or deleting a Chapter or its Illustrations.
export const MAY_CHANGE_CHAPTERS =
  'You may only change chapters in books you co-author';

export type WorkRef = { book: number } | { series: number };
export type CoAuthorRef =
  WorkRef | { chapter: number } | { illustration: number };

const isBookRef = (ref: CoAuthorRef): ref is { book: number } => 'book' in ref;

export interface CoAuthorGuard {
  assertMayChange(
    req: Request,
    ref: CoAuthorRef,
    refusal: string
  ): Promise<void>;
  assertCoAuthor(req: Request, ref: WorkRef, refusal: string): Promise<void>;
  assertMayRemoveCredit(
    req: Request,
    ref: WorkRef,
    userId: number,
    refusal: string
  ): Promise<void>;
}

export function createCoAuthorGuard(deps: {
  bookRepository: Pick<BookRepository, 'findCoAuthorIds'>;
  seriesRepository: Pick<SeriesRepository, 'findCoAuthorIds'>;
  chapterRepository: Pick<ChapterRepository, 'findCoAuthorIds'>;
  illustrationRepository: Pick<IllustrationRepository, 'findCoAuthorIds'>;
}): CoAuthorGuard {
  // The Co-authors answering for the ref's row; a missing row is a 404 naming
  // its resource.
  const coAuthorsOf = async (ref: CoAuthorRef): Promise<number[]> => {
    let resource: string;
    let id: number;
    let coAuthorIds: number[] | null;
    if (isBookRef(ref)) {
      resource = 'Book';
      id = ref.book;
      coAuthorIds = await deps.bookRepository.findCoAuthorIds(id);
    } else if ('series' in ref) {
      resource = 'Series';
      id = ref.series;
      coAuthorIds = await deps.seriesRepository.findCoAuthorIds(id);
    } else if ('chapter' in ref) {
      resource = 'Chapter';
      id = ref.chapter;
      coAuthorIds = await deps.chapterRepository.findCoAuthorIds(id);
    } else if ('illustration' in ref) {
      resource = 'Illustration';
      id = ref.illustration;
      coAuthorIds = await deps.illustrationRepository.findCoAuthorIds(id);
    } else {
      // A new CoAuthorRef kind fails to compile here until it has a branch.
      const unhandled: never = ref;
      return unhandled;
    }
    if (coAuthorIds === null) throw new NotFoundError(resource, id);
    return coAuthorIds;
  };

  const refuseUncredited = (
    req: Request,
    coAuthorIds: number[],
    refusal: string
  ): void => {
    if (req.user === undefined || !coAuthorIds.includes(req.user.id)) {
      throw new ForbiddenError(refusal);
    }
  };

  return {
    // Editing a work, its chapters or its order: a Co-author, or a Moderator
    // under `any`. Only `any` skips the comparison (see requirePermission.ts).
    assertMayChange: async (req, ref, refusal) => {
      const coAuthorIds = await coAuthorsOf(ref);
      if (req.permissionScope === 'any') return;
      refuseUncredited(req, coAuthorIds, refusal);
    },

    // The byline: a Co-author only, whatever the scope. A Moderator may edit a
    // work but never change who wrote it.
    assertCoAuthor: async (req, ref, refusal) => {
      refuseUncredited(req, await coAuthorsOf(ref), refusal);
    },

    // Taking a credit off a work. The route sits behind requireAuth alone, so
    // no scope is stamped. The matrix is read here, so a Co-author who switched
    // to Role `user` (`none` on the module) can still leave. Leaving needs no
    // check: the repository answers 404 for an uncredited account and 409 for
    // the last Co-author. Removing someone else needs scope exactly `own`
    // (`none` is no longer an author; `any` is a Moderator, who never changes a
    // byline, ADR-0005) and a credit on the work.
    assertMayRemoveCredit: async (req, ref, userId, refusal) => {
      if (!req.user) throw new UnauthorizedError();
      if (userId === req.user.id) return;
      const module = isBookRef(ref) ? 'books' : 'series';
      if (scopeFor(req.user.role, module, 'update') !== 'own') {
        throw new ForbiddenError('Only a co-author may remove a co-author');
      }
      refuseUncredited(req, await coAuthorsOf(ref), refusal);
    },
  };
}
