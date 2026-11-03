import type { RequestHandler } from 'express';
import { validatedBody, validatedParams } from '../middleware/validate.ts';
import type { Actor } from '../repositories/notificationRepository.ts';
import { actorOf } from '../repositories/visibility.ts';
import { NotFoundError } from '../types/errors.ts';
import type { AddCoAuthorInput } from '../types/params.ts';
import type { CoAuthorGuard, WorkRef } from './coAuthorGuard.ts';

// null when the work is not there, as the repositories report it.
type CreditChange = (
  id: number,
  userId: number,
  actor: Actor
) => Promise<object | null>;

interface CreditHandlerOptions {
  guard: CoAuthorGuard;
  // The ref key and what a missing row is called ('Book' | 'Series').
  kind: 'book' | 'series';
  // The 403 for an account that is not credited on the work.
  refusal: string;
  repository: { addCoAuthor: CreditChange; removeCoAuthor: CreditChange };
}

// The byline of a book or a series (ADR-0005): every Co-author holds the same
// rights, and a Moderator may edit or delete any work but never change who is
// credited on it. The rules themselves live in coAuthorGuard.ts.
//
// No try/catch: the Express 5 router inspects the returned promise and calls
// next(err) itself when it rejects.
export function creditHandlers({
  guard,
  kind,
  refusal,
  repository,
}: CreditHandlerOptions) {
  const resource = kind === 'book' ? 'Book' : 'Series';
  const refOf = (id: number) => ({ [kind]: id }) as WorkRef;
  return {
    // Rides on `× update`, then requires a Co-author: a Moderator's `any`
    // reaches every work but never its byline.
    addCoAuthor: async (req, res) => {
      const { id } = validatedParams<{ id: number }>(req);
      const { userId } = validatedBody<AddCoAuthorInput>(req);
      await guard.assertCoAuthor(req, refOf(id), refusal);

      const updated = await repository.addCoAuthor(id, userId, actorOf(req));
      if (!updated) throw new NotFoundError(resource, id);
      res.json(updated);
    },

    // Mounted behind requireAuth alone; assertMayRemoveCredit says why and
    // decides who may remove whom.
    removeCoAuthor: async (req, res) => {
      const { id, userId } = validatedParams<{ id: number; userId: number }>(
        req
      );
      await guard.assertMayRemoveCredit(req, refOf(id), userId, refusal);

      const updated = await repository.removeCoAuthor(id, userId, actorOf(req));
      if (!updated) throw new NotFoundError(resource, id);
      res.json(updated);
    },
  } satisfies Record<string, RequestHandler>;
}
