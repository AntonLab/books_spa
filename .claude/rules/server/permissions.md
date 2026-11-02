---
paths:
  - 'server/src/permissions/**'
  - 'server/src/middleware/requirePermission.ts'
  - 'server/src/types/permission.ts'
  - 'server/src/models/Permission.ts'
  - 'server/src/controllers/userController.ts'
  - 'server/src/routes/userRoutes.ts'
---

# Roles and the permission matrix

## The matrix

- `role × module × action → none | own | any` (`permissions/matrix.ts`). A
  boolean could not tell "an author updates the books they wrote" from "an
  admin updates anyone's", and that difference would fall back into every
  controller.
- `guest` is a matrix role but never stored: `ROLES` is
  `['guest', ...USER_ROLES]`. A request with no session is `guest`, so a public
  read is a row in the matrix, not a missing guard.
- `PERMISSION_DEFINITION` lists grants only; `buildMatrixRows()` expands the
  rest to `none`, so a missing row is never an accidental grant.
- `reports` has matrix rows (admin and superadmin hold `any`), but the report
  routes do not check them: creating a report needs only `requireAuth` (any
  signed-in Account may report), and the Moderator list routes use
  `requireModerator`.
- On `create`, `own` and `any` mean the same thing, since a new row is the
  caller's by construction. The create path still checks rows after the matrix:
  `assertMayAddToSeries` for a book filed into a series, and `assertMayChange`
  on the book for a chapter.
- **Admins moderate; they do not author.** `admin` and `superadmin` get no
  `create` on `books`, `series` or `chapters`, and `update: own` rather than
  `any` on `comments` and `likes`: a Moderator removes, never rewrites.
- `genres` has no `own` anywhere, since a Genre has no Owner: everyone reads;
  `admin` (and `superadmin` through its blanket `any`) writes. Setting a work's
  `genreId` rides on that work's own grant.
- `favorites` is `create`/`delete: own` for every signed-in role, superadmin
  included, and nothing for `guest`. No role gets `read` or `update`: a
  Favorite is private and has nothing to edit, so the two lists sit behind
  `requireAuth` and read the session's own rows.

## Enforcement

- `requirePermission(module, action)` refuses on `none`: **401 with no session,
  403 for a known role without the grant**. On `own`/`any` it stamps
  `req.permissionScope` and lets the controller judge the row (`access.md`).
- `permissionStore.ts` seeds its `Map` from `buildMatrixRows()` at import time,
  before any database call, so `scopeFor` is right in any process, a test
  without MySQL included. An empty-until-synced cache would make a
  misconfiguration look like a deliberate 403.
- `syncPermissions()` replaces the table wholesale in a transaction
  (destroy-then-`bulkCreate`; an upsert would leave orphan rows). It runs on
  every boot, right after `sequelize.sync()`.
- `permissions.module` is a MySQL `ENUM` built from `MODULES`; a new module
  needs the table recreated (`/db-reset`) before the sync can insert its rows.

## Accounts

- `POST /api/users` reaches only `superadmin`. Public signup is
  `POST /api/auth/register`, limited to `REGISTRABLE_ROLES` (`user`/`author`).
- `PATCH /api/users/:id/role` is the one door for role changes
  (`updateRoleSchema`). The matrix grades the resource; the handler grades the
  value. A `superadmin` sets any role on anyone. Everyone else only on their own
  row, and only to `user` or `author` — so an admin can step down but not
  promote anyone.
- The first `superadmin` is manual SQL, because no API can grant the role:
  `UPDATE users SET role = 'superadmin' WHERE login = '<login>';`
- **Rank** (`userController.assertMayTouch`): an admin may `PATCH`/`DELETE`
  their own row and accounts whose role is in `ADMIN_MANAGEABLE_ROLES`
  (`user`/`author`); another admin or a superadmin is 403, a missing id 404
  first. A superadmin reaches everyone but may not delete their own account or
  change their own role. A `user`/`author` reaches only their own row, refused
  without a lookup. Rank protects accounts only: an admin may remove a
  superadmin's comment.
- On your own row, a `status` key is 403 even when it changes nothing. A new
  `password` or `email` needs `currentPassword` in the same body (missing 400,
  wrong 403; guesses are rate limited, see `rate-limits.md`); it is never stored.
- `pending` is the default status and restricts nothing (`CONTEXT.md`).
