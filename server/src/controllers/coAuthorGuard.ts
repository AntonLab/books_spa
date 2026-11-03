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

export interface CoAuthorTarget {
  // What a missing row is reported as.
  resource: 'Book' | 'Series' | 'Chapter' | 'Illustration';
  id: number;
  // The Co-authors answering for the row, or null when it does not exist.
  coAuthorIds: () => Promise<number[] | null>;
}

async function coAuthorsOf(target: CoAuthorTarget): Promise<number[]> {
  const coAuthorIds = await target.coAuthorIds();
  if (coAuthorIds === null) {
    throw new NotFoundError(target.resource, target.id);
  }
  return coAuthorIds;
}

function refuseUncredited(
  req: Request,
  coAuthorIds: number[],
  refusal: string
): void {
  if (req.user === undefined || !coAuthorIds.includes(req.user.id)) {
    throw new ForbiddenError(refusal);
  }
}

// Editing a work, its chapters or its order: a Co-author, or a Moderator
// under `any`. Only `any` skips the comparison (see requirePermission.ts).
export async function assertMayChange(
  req: Request,
  target: CoAuthorTarget,
  refusal: string
): Promise<void> {
  const coAuthorIds = await coAuthorsOf(target);
  if (req.permissionScope === 'any') return;
  refuseUncredited(req, coAuthorIds, refusal);
}

// The byline: a Co-author only, whatever the scope. A Moderator may edit a
// work but never change who wrote it.
export async function assertCoAuthor(
  req: Request,
  target: CoAuthorTarget,
  refusal: string
): Promise<void> {
  refuseUncredited(req, await coAuthorsOf(target), refusal);
}

// Taking a credit off a work. The route sits behind requireAuth alone, so a
// Co-author who switched Role to `user` (`none` on the module) can still
// leave; that is why the matrix is read here rather than stamped by
// requirePermission. Leaving needs no check: the repository answers 404 for
// an uncredited account and 409 for the last Co-author. Removing someone else
// takes exactly `own` — `none` is no longer an author and `any` is a
// Moderator, who never changes a byline (ADR-0005) — and a credit.
export async function assertMayRemoveCredit(
  req: Request,
  target: CoAuthorTarget,
  module: 'books' | 'series',
  userId: number,
  refusal: string
): Promise<void> {
  if (!req.user) throw new UnauthorizedError();
  if (userId === req.user.id) return;
  if (scopeFor(req.user.role, module, 'update') !== 'own') {
    throw new ForbiddenError('Only a co-author may remove a co-author');
  }
  await assertCoAuthor(req, target, refusal);
}

export type WorkRef = { book: number } | { series: number };
export type CoAuthorRef =
  WorkRef | { chapter: number } | { illustration: number };

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
  const targetOf = (ref: CoAuthorRef): CoAuthorTarget => {
    if ('book' in ref) {
      return {
        resource: 'Book',
        id: ref.book,
        coAuthorIds: () => deps.bookRepository.findCoAuthorIds(ref.book),
      };
    }
    if ('series' in ref) {
      return {
        resource: 'Series',
        id: ref.series,
        coAuthorIds: () => deps.seriesRepository.findCoAuthorIds(ref.series),
      };
    }
    if ('chapter' in ref) {
      return {
        resource: 'Chapter',
        id: ref.chapter,
        coAuthorIds: () => deps.chapterRepository.findCoAuthorIds(ref.chapter),
      };
    }
    return {
      resource: 'Illustration',
      id: ref.illustration,
      coAuthorIds: () =>
        deps.illustrationRepository.findCoAuthorIds(ref.illustration),
    };
  };
  return {
    assertMayChange: (req, ref, refusal) =>
      assertMayChange(req, targetOf(ref), refusal),
    assertCoAuthor: (req, ref, refusal) =>
      assertCoAuthor(req, targetOf(ref), refusal),
    assertMayRemoveCredit: (req, ref, userId, refusal) =>
      assertMayRemoveCredit(
        req,
        targetOf(ref),
        'book' in ref ? 'books' : 'series',
        userId,
        refusal
      ),
  };
}
