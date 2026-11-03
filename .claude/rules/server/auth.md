---
paths:
  - 'server/src/middleware/csrfProtection*'
  - 'server/src/middleware/errorHandler*'
  - 'server/src/middleware/requireAuth*'
  - 'server/src/middleware/requireModerator*'
  - 'server/src/middleware/requirePermission*'
  - 'server/src/middleware/sessionUser*'
  - 'server/src/middleware/validate*'
  - 'server/src/controllers/authController.ts'
  - 'server/src/accountSession.ts'
  - 'server/src/routes/authRoutes.ts'
  - 'server/src/repositories/sessionRepository.ts'
  - 'server/src/repositories/passwordResetRepository.ts'
  - 'server/src/repositories/userRepository.ts'
  - 'server/src/sessionCookie.ts'
  - 'server/src/tokens.ts'
  - 'server/src/password.ts'
  - 'server/src/rateLimit.ts'
  - 'server/src/delivery/**'
---

# Sessions, sign-in, reset and CSRF

## Sessions

- `sid` is an opaque 32-byte base64url token: `httpOnly`, `sameSite: 'lax'`
  (so a reset link from a mail client arrives signed in), `secure` only in
  production, seven days. Set and cleared through one options object in
  `sessionCookie.ts`: a `clearCookie` with different options leaves the cookie.
- Session and reset tokens are stored as SHA-256 hashes, not argon2 (ADR-0001).
- Login opens a new row and deletes the one its cookie names (fixation).
- `resolveSessionUser` (`middleware/sessionUser.ts`) reports nobody for a
  missing cookie, unknown token, expired session, deleted or Blocked
  Account: a guarded route answers 401, a public one serves a Guest. The
  lookup is `findForAuth` (no avatar query), and the `lastSeenAt` stamp is
  skipped while the stored value is fresh (within `LAST_ONLINE_WINDOW_MS`).

## Login

- Sign-in and reset rules live in `accountSession.ts`; the controller keeps parsing, cookies and the response (the 202 goes out before the module is called).
- **Sign-in takes a login or an email** in the one `login` field. An `@` in the
  value picks the column: with one it is an email (case-insensitive,
  accent-sensitive), without one a login (case-sensitive). A login may not
  contain `@` (`createUserSchema` and `registerSchema`), so the two cannot
  collide; an old row with `@` in its login signs in by email only, and gets
  400 on a `PATCH /api/users/:id` that resends its unchanged login.
- **One answer to two questions**: an unknown login or email and a wrong
  password give the same 401, and the unknown-login path spends an argon2
  verify on a cached dummy hash so timing cannot tell them apart.
  `accountSession.spec.ts` drives the `verify` seam: a wall-clock assertion
  would flake, and an ESM binding cannot be spied on.
- A blocked account is checked **after** the password, or the 403 would confirm
  the account to someone without it.
- **A login in flight cannot outlive a block or a password change.** argon2 is
  slow enough for either to commit mid-verify, so `createIfCredentialCurrent`
  re-reads the account under `SELECT … FOR SHARE` in the session insert's
  transaction and inserts nothing unless the hash is unchanged and the account
  not blocked. `register` skips this: a new account has nothing in flight.

## Registration

- A taken login or email answers 409 naming the field (`ConflictError`,
  `asConflict` in `userRepository.ts`). This is a deliberate exception to the
  "one answer" stance of Login and reset: there is no email-verification step
  yet (the Pending status is reserved for it), so a generic answer would leave a
  real user unable to tell why registration failed. The register rate limit
  (5 per hour per IP, table in `rate-limits.md`) bounds enumeration through it.
  Revisit when email verification lands.

## Blocking and password changes

- Blocking ends the account's sessions in the same transaction, only on the
  transition into `blocked`. A block written straight into the table purges
  nothing; `resolveSessionUser` is the second layer that catches it.
- Blocking does not touch content: no query filters by a Co-author's `status`.
  Hiding a Blocked Account's work is a separate Moderator action.
- A password change through `PATCH /api/users/:id` ends every session on the
  account, the caller's included, and clears the caller's own `sid`.

## Password reset

- A request always answers 202, or the endpoint would enumerate accounts. The
  202 goes out right after validation, before the account lookup, the token
  swap (`replaceForUser`) and the send, all of which run detached
  (`void … .catch(...)`). A new request supersedes the outstanding token in
  one transaction that locks the Account's row, so concurrent requests leave
  one live token. Tokens live one hour: a link sits in a mailbox.
- Confirmation stores the password, stamps the token used and revokes every
  session in one transaction. Unknown, expired and used tokens share one 400.
- The link leaves through `MailDelivery` (`delivery/mailDelivery.ts`):
  `passwordResetMail` composes it, `MAIL_DELIVERY` picks `log` or `smtp`.
- Never await or branch on the lookup, token writes or send. A failure anywhere
  in the chain is logged (`accountSession.ts`: `Password reset request failed`,
  or `Password reset mail failed` for the send; no address or token in the
  line) and not retried. The account can ask again; the new request supersedes
  the stored token.

## CSRF (`middleware/csrfProtection.ts`)

Two layers ahead of every route; neither leans on `sameSite: 'lax'`. Reads pass.

- **`createCrossOriginProtection`**, after Go's `http.CrossOriginProtection`:
  an `Origin` equal to `APP_BASE_URL` passes (the client reaches the API through
  its dev proxy, under another Host); otherwise `Sec-Fetch-Site` must be
  `same-origin` or `none`; with no `Sec-Fetch-Site`, `Origin` must name the
  request's own host; with neither header it is not a browser and passes.
- **`requireXsrfToken`**: `xsrfToken` (not httpOnly) holds
  `HMAC-SHA256(session token, "xsrf")`; a write carrying `sid` must echo it in
  `X-XSRF-Token`. It is bound to the session, so a token planted by a sibling
  subdomain fails. No session, no token needed. A missing or stale token cookie
  is reissued.
- Route specs get the token from `routeTestKit.testkit.ts`; the refusals are
  covered in `csrfProtection.spec.ts`; `app.spec.ts` does the real handshake.

Rate limits: `rate-limits.md`.
