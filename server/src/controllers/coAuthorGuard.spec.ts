import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { USER_ROLES, type UserRole } from 'shared';
import { buildMatrixRows } from '../permissions/matrix.ts';
import { loadMatrix } from '../permissions/permissionStore.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../types/errors.ts';
import type { PermissionScope } from '../types/permission.ts';
import {
  createCoAuthorGuard,
  type CoAuthorRef,
  type WorkRef,
} from './coAuthorGuard.ts';

const REFUSAL = 'You may only change books you co-author';

const requestAs = (
  userId: number | undefined,
  permissionScope?: PermissionScope
): Request =>
  ({
    user: userId === undefined ? undefined : { id: userId, role: 'author' },
    permissionScope,
  }) as Request;

// Removing a credit sits behind requireAuth alone, so no scope is stamped and
// the guard reads the matrix for the caller's Role itself.
const signedInAs = (userId: number, role: UserRole): Request =>
  ({ user: { id: userId, role } }) as Request;

const ONLY_A_CO_AUTHOR = 'Only a co-author may remove a co-author';

type Kind = 'book' | 'series' | 'chapter' | 'illustration';
const KINDS: Kind[] = ['book', 'series', 'chapter', 'illustration'];

const RESOURCE_NAME = {
  book: 'Book',
  series: 'Series',
  chapter: 'Chapter',
  illustration: 'Illustration',
} as const;

// Four repository doubles over one credits table; every lookup is recorded
// as `${kind}:${id}` so a test can tell which row was resolved.
const guardOver = (credits: Record<Kind, number[] | null>) => {
  const lookups: string[] = [];
  const repositoryOf = (kind: Kind) => ({
    findCoAuthorIds: (id: number) => {
      lookups.push(`${kind}:${id}`);
      return Promise.resolve(credits[kind]);
    },
  });
  const guard = createCoAuthorGuard({
    bookRepository: repositoryOf('book'),
    seriesRepository: repositoryOf('series'),
    chapterRepository: repositoryOf('chapter'),
    illustrationRepository: repositoryOf('illustration'),
  });
  return { guard, lookups };
};

// Every kind credited to account 9 except `kind`, which gets `ids`.
const creditedOn = (kind: Kind, ids: number[] | null) => ({
  book: [9],
  series: [9],
  chapter: [9],
  illustration: [9],
  [kind]: ids,
});

const refTo = (kind: Kind, id: number) => ({ [kind]: id }) as CoAuthorRef;
const workRefTo = (kind: 'book' | 'series', id: number) =>
  ({ [kind]: id }) as WorkRef;

describe('createCoAuthorGuard', () => {
  describe('assertMayChange', () => {
    for (const kind of KINDS) {
      test(`${kind}: Co-author under own passes, uncredited gets 403 with the refusal`, async () => {
        const { guard } = guardOver(creditedOn(kind, [1, 2]));
        await guard.assertMayChange(
          requestAs(1, 'own'),
          refTo(kind, 7),
          REFUSAL
        );
        await guard
          .assertMayChange(requestAs(3, 'own'), refTo(kind, 7), REFUSAL)
          .then(
            () => assert.fail('expected a refusal'),
            (error: unknown) => {
              assert.ok(error instanceof ForbiddenError);
              assert.equal(error.message, REFUSAL);
            }
          );
      });

      test(`${kind}: a missing row is 404 naming ${RESOURCE_NAME[kind]}, under own and under any`, async () => {
        const { guard } = guardOver(creditedOn(kind, null));
        for (const scope of ['own', 'any'] as const) {
          await guard
            .assertMayChange(requestAs(3, scope), refTo(kind, 7), REFUSAL)
            .then(
              () => assert.fail('expected a 404'),
              (error: unknown) => {
                assert.ok(error instanceof NotFoundError);
                assert.match(error.message, new RegExp(RESOURCE_NAME[kind]));
              }
            );
        }
      });

      test(`${kind}: any passes a row it is not credited on after exactly one lookup of ${kind}:7`, async () => {
        const { guard, lookups } = guardOver(creditedOn(kind, [1]));
        await guard.assertMayChange(
          requestAs(3, 'any'),
          refTo(kind, 7),
          REFUSAL
        );
        assert.deepEqual(lookups, [`${kind}:7`]);
      });

      test(`${kind}: no scope stamped, or no account, fails closed with 403`, async () => {
        const { guard } = guardOver(creditedOn(kind, [1]));
        await assert.rejects(
          guard.assertMayChange(requestAs(3), refTo(kind, 7), REFUSAL),
          ForbiddenError
        );
        await assert.rejects(
          guard.assertMayChange(
            requestAs(undefined, 'own'),
            refTo(kind, 7),
            REFUSAL
          ),
          ForbiddenError
        );
      });
    }
  });

  describe('assertCoAuthor', () => {
    test('a Moderator under any is refused on book and series; the Co-author passes whatever the scope', async () => {
      for (const kind of ['book', 'series'] as const) {
        const { guard, lookups } = guardOver(creditedOn(kind, [1]));
        await assert.rejects(
          guard.assertCoAuthor(
            requestAs(3, 'any'),
            workRefTo(kind, 7),
            REFUSAL
          ),
          ForbiddenError
        );
        assert.deepEqual(lookups, [`${kind}:7`]);
        for (const scope of ['any', 'own'] as const) {
          await guard.assertCoAuthor(
            requestAs(1, scope),
            workRefTo(kind, 7),
            REFUSAL
          );
        }
      }
    });

    test('a missing book or series is 404 naming the resource', async () => {
      for (const kind of ['book', 'series'] as const) {
        const { guard } = guardOver(creditedOn(kind, null));
        await guard
          .assertCoAuthor(requestAs(1, 'own'), workRefTo(kind, 7), REFUSAL)
          .then(
            () => assert.fail('expected a 404'),
            (error: unknown) => {
              assert.ok(error instanceof NotFoundError);
              assert.match(error.message, new RegExp(RESOURCE_NAME[kind]));
            }
          );
      }
    });
  });

  describe('assertMayRemoveCredit', () => {
    test('no account is 401 before any lookup', async () => {
      const { guard, lookups } = guardOver(creditedOn('book', [1]));
      await assert.rejects(
        guard.assertMayRemoveCredit(
          requestAs(undefined),
          { book: 7 },
          1,
          REFUSAL
        ),
        UnauthorizedError
      );
      assert.equal(lookups.length, 0);
    });

    test('each Role removes itself with zero lookups', async () => {
      for (const role of USER_ROLES) {
        const { guard, lookups } = guardOver(creditedOn('book', null));
        await guard.assertMayRemoveCredit(
          signedInAs(1, role),
          { book: 7 },
          1,
          REFUSAL
        );
        assert.equal(lookups.length, 0);
      }
    });

    test('removing another: user/admin/superadmin get 403 "Only a co-author may remove a co-author" with zero lookups', async () => {
      for (const role of ['user', 'admin', 'superadmin'] as const) {
        const { guard, lookups } = guardOver(creditedOn('book', [1, 2]));
        await guard
          .assertMayRemoveCredit(signedInAs(1, role), { book: 7 }, 2, REFUSAL)
          .then(
            () => assert.fail('expected a refusal'),
            (error: unknown) => {
              assert.ok(error instanceof ForbiddenError);
              assert.equal(error.message, ONLY_A_CO_AUTHOR);
            }
          );
        assert.equal(lookups.length, 0);
      }
    });

    test('removing another: an author (own) credited on the work passes; uncredited gets 403 REFUSAL; missing work is 404', async () => {
      const credited = guardOver(creditedOn('book', [1, 2]));
      await credited.guard.assertMayRemoveCredit(
        signedInAs(1, 'author'),
        { book: 7 },
        2,
        REFUSAL
      );
      assert.deepEqual(credited.lookups, ['book:7']);

      await credited.guard
        .assertMayRemoveCredit(signedInAs(3, 'author'), { book: 7 }, 1, REFUSAL)
        .then(
          () => assert.fail('expected a refusal'),
          (error: unknown) => {
            assert.ok(error instanceof ForbiddenError);
            assert.equal(error.message, REFUSAL);
          }
        );

      const missing = guardOver(creditedOn('book', null));
      await assert.rejects(
        missing.guard.assertMayRemoveCredit(
          signedInAs(3, 'author'),
          { book: 7 },
          1,
          REFUSAL
        ),
        NotFoundError
      );
    });

    test('reads the matrix per module: books vs series', async (t) => {
      loadMatrix(
        buildMatrixRows().map((row) =>
          row.role === 'author' &&
          row.module === 'series' &&
          row.action === 'update'
            ? { ...row, scope: 'none' as const }
            : row
        )
      );
      t.after(() => loadMatrix(buildMatrixRows()));

      const { guard, lookups } = guardOver({
        book: [1, 2],
        series: [1, 2],
        chapter: null,
        illustration: null,
      });
      await assert.rejects(
        guard.assertMayRemoveCredit(
          signedInAs(1, 'author'),
          { series: 7 },
          2,
          REFUSAL
        ),
        ForbiddenError
      );
      assert.equal(lookups.length, 0);
      await guard.assertMayRemoveCredit(
        signedInAs(1, 'author'),
        { book: 7 },
        2,
        REFUSAL
      );
      assert.deepEqual(lookups, ['book:7']);
    });
  });
});
