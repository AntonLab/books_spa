---
paths:
  - 'server/src/middleware/authRateLimit.ts'
  - 'server/src/routes/*Routes.ts'
  - 'server/src/rateLimit.ts'
---

# Rate limiting (`middleware/authRateLimit.ts`)

Sign-in, registration, password, upload and write budgets. In memory, fixed
window. Login, register and reset mount before `validate`, so a refusal costs
no parse, lookup or argon2. Comment, like, report, chapter and
reading-progress writes mount after `validate` (an invalid request spends
nothing), upload PUTs after `validate` and before `express.raw`, so a refused
body is never read. A request with no user passes the limiter; the route
refuses it. A limited Account is not Blocked.

| Route                                                                    | Key        | Limit         | Counts                                                               |
| ------------------------------------------------------------------------ | ---------- | ------------- | -------------------------------------------------------------------- |
| `POST /api/auth/login`                                                   | IP + login | 10 per 15 min | failed or aborted attempts                                           |
| `POST /api/auth/login`                                                   | IP         | 50 per 15 min | failed or aborted attempts                                           |
| `POST /api/auth/register`                                                | IP         | 5 per hour    | every request                                                        |
| `POST /api/auth/password-reset/request`                                  | IP         | 5 per hour    | every request                                                        |
| `POST /api/auth/password-reset/confirm`                                  | IP         | 10 per hour   | every request                                                        |
| `PATCH /api/users/:id`                                                   | user id    | 5 per 15 min  | wrong or aborted `currentPassword` attempts; a correct one clears it |
| `PUT` book cover, series cover, user avatar                              | user id    | 20 per 15 min | every request that passes the permission check and `validate`        |
| `POST/PATCH/DELETE` comments, likes, reports, chapters, reading progress | user id    | 60 per 15 min | every request that passes the permission check and `validate`        |

- A malformed image spends upload budget; the upload DELETE routes are free.
- Reading progress has no permission check: it counts every request that passes
  `requireAuth` and `validate`.
- **Login claims both budgets on arrival** (`hit`), or parallel attempts would
  all read the same unspent count while argon2 runs. A refusal releases
  **both** claims, or refused attempts would keep extending their own lockout.
  A 401 or an abort keeps both: the handler still runs argon2 after the client
  leaves, so returning an abort's claims would buy unlimited argon2 work. A 400,
  403 or 2xx releases both, and a 2xx also clears the IP + login history. The
  per-IP budget survives a success, or one real account buys fresh guesses at
  every other.
- **`currentPassword` is charged on arrival**, before argon2, in
  `userController.assertCurrentPassword`, for the same parallel-guess reason.
  Over budget is 429 even with the right password. A missing `currentPassword`
  stays 400 and uncharged, as does a change needing none.
- The login key half is trimmed, lower-cased and SHA-256 hashed: case or
  whitespace buys no fresh budget, and an unbounded `login` (read before
  `validate`) leaves no unbounded key in memory.
- Refusal is 429 with `Retry-After` in whole seconds and "Try again in N
  minutes." (singular at 1). IP budgets key on `req.ip`, so `TRUST_PROXY`
  matters behind a proxy: production must set it (0 is valid) or boot fails.
  Counts are per process and lost on restart.
- Harnesses pass `unlimitedAuthRateLimits()`; the real set is used only by
  `authRateLimit`, `uploadRateLimit` and `writeRateLimit` specs and
  `authRoutes.spec.ts`'s rate-limit cases.
