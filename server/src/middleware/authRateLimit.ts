import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { createRateLimiter, type RateLimiter } from '../rateLimit.ts';
import { TooManyRequestsError } from '../types/errors.ts';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// The rate-limit budgets. A limit is not an Account state: nothing is
// written anywhere, and a limited Account is not Blocked.
export const AUTH_RATE_LIMITS = {
  // Failed logins for one login name from one address.
  loginByIpAndLogin: { limit: 10, windowMs: FIFTEEN_MINUTES_MS },
  // Failed logins from one address, whatever the name.
  loginByIp: { limit: 50, windowMs: FIFTEEN_MINUTES_MS },
  // Every registration request from one address.
  register: { limit: 5, windowMs: ONE_HOUR_MS },
  // Every password-reset request from one address.
  resetRequest: { limit: 5, windowMs: ONE_HOUR_MS },
  // Every password-reset confirmation from one address.
  resetConfirm: { limit: 10, windowMs: ONE_HOUR_MS },
  // Wrong or aborted current-password guesses on a user's own password or
  // email change, by user id; a correct one clears it.
  currentPassword: { limit: 5, windowMs: FIFTEEN_MINUTES_MS },
  // Upload PUTs (avatar, book cover, series cover) share one budget per user
  // id. It guards the image decode.
  upload: { limit: 20, windowMs: FIFTEEN_MINUTES_MS },
  // Every comment, like, report and chapter write per user id; stops a
  // signed-in account flooding the database.
  write: { limit: 60, windowMs: FIFTEEN_MINUTES_MS },
} as const;

export interface AuthRateLimits {
  readonly loginByIpAndLogin: RateLimiter;
  readonly loginByIp: RateLimiter;
  readonly register: RateLimiter;
  readonly resetRequest: RateLimiter;
  readonly resetConfirm: RateLimiter;
  readonly currentPassword: RateLimiter;
  readonly upload: RateLimiter;
  readonly write: RateLimiter;
  // Stops every limiter's sweep; the graceful shutdown calls it.
  stop(): void;
}

export function createAuthRateLimits(): AuthRateLimits {
  const limiters = {
    loginByIpAndLogin: createRateLimiter(AUTH_RATE_LIMITS.loginByIpAndLogin),
    loginByIp: createRateLimiter(AUTH_RATE_LIMITS.loginByIp),
    register: createRateLimiter(AUTH_RATE_LIMITS.register),
    resetRequest: createRateLimiter(AUTH_RATE_LIMITS.resetRequest),
    resetConfirm: createRateLimiter(AUTH_RATE_LIMITS.resetConfirm),
    currentPassword: createRateLimiter(AUTH_RATE_LIMITS.currentPassword),
    upload: createRateLimiter(AUTH_RATE_LIMITS.upload),
    write: createRateLimiter(AUTH_RATE_LIMITS.write),
  };

  return {
    ...limiters,
    stop() {
      for (const limiter of Object.values(limiters)) limiter.stop();
    },
  };
}

// The address a budget is kept against. req.ip follows TRUST_PROXY, so behind
// a trusted proxy it is the client the proxy names, not the proxy itself.
const addressOf = (req: Request): string => req.ip ?? 'unknown';

// The login a failed attempt counts against, trimmed and lower-cased so that
// a change of case or stray whitespace buys no fresh budget. The login column
// itself is case-sensitive (utf8mb4_0900_as_cs), so two accounts that differ
// only in case share one budget per address — the limit errs toward refusing.
// Read before validate runs, so anything but a string is the empty name.
function normalisedLogin(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    'login' in body &&
    typeof body.login === 'string'
  ) {
    return body.login.trim().toLowerCase();
  }
  return '';
}

// The name half of the key is a SHA-256 hex digest: loginSchema caps nothing
// and this runs before validate, so a 100 KB login (the express.json() limit)
// would otherwise sit in the limiter's map until the sweep.
function loginNameKey(address: string, body: unknown): string {
  const digest = createHash('sha256')
    .update(normalisedLogin(body))
    .digest('hex');
  return JSON.stringify([address, digest]);
}

export function refusal(
  res: Response,
  retryAfterMs: number
): TooManyRequestsError {
  // Whole seconds, rounded up, so a client that waits exactly this long is
  // not refused again by the same window.
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  return new TooManyRequestsError(retryAfterMs);
}

// Register, the reset request and the reset confirmation: every request
// counts, before validate, so malformed spam spends the budget too.
export function limitEveryRequest(
  limiter: RateLimiter,
  keyOf: (req: Request) => string = addressOf
): RequestHandler {
  return (req, res, next) => {
    const { allowed, retryAfterMs } = limiter.hit(keyOf(req));
    if (!allowed) {
      next(refusal(res, retryAfterMs));
      return;
    }
    next();
  };
}

// Upload PUTs: every request counts, by user id. No user: pass on, the route
// refuses it. Mount order: see rules/server/rate-limits.md.
export function limitEveryRequestByUser(limiter: RateLimiter): RequestHandler {
  const count = limitEveryRequest(limiter, (req) => String(req.user?.id));
  return (req, res, next) => {
    if (!req.user) {
      next();
      return;
    }
    count(req, res, next);
  };
}

// The shared per-user budget of the comment, like, report and chapter writes.
export const limitUserWrites = (deps: {
  authRateLimits: AuthRateLimits;
}): RequestHandler => limitEveryRequestByUser(deps.authRateLimits.write);

// Login: only a failure counts (a 401, or an abort: the connection closing
// before any answer goes out). Both budgets are charged the moment the request
// arrives, before validate or argon2, and the hit is given back only when an
// answer other than a 401 goes out. Counting later would let C parallel
// requests spend about one slot, since all wait on argon2 and read the same
// count. Node runs one request's synchronous middleware to completion, so each
// arrival claims its own slot.
export function limitFailedLogins(
  limits: Pick<AuthRateLimits, 'loginByIpAndLogin' | 'loginByIp'>
): RequestHandler {
  return (req, res, next) => {
    const address = addressOf(req);
    const nameKey = loginNameKey(address, req.body);

    const nameHit = limits.loginByIpAndLogin.hit(nameKey);
    const addressHit = limits.loginByIp.hit(address);
    const refused = [nameHit, addressHit].filter((state) => !state.allowed);

    if (refused.length > 0) {
      // Refused requests never reach the handler, so both budgets give back
      // their hit, including the one that did not refuse, because hit() always
      // increments.
      limits.loginByIpAndLogin.release(nameKey);
      limits.loginByIp.release(address);
      next(
        refusal(res, Math.max(...refused.map((state) => state.retryAfterMs)))
      );
      return;
    }

    // Settled exactly once, by whichever of 'finish' and 'close' comes
    // first. 'close' follows every 'finish'; one that comes first is an
    // abort, which never fires 'finish'.
    let settled = false;
    res.on('finish', () => {
      if (settled) return;
      settled = true;
      if (res.statusCode === 401) {
        // A genuine failure: both claims stay spent.
        return;
      }
      // Of the answers, only a 401 is an attempt worth counting.
      limits.loginByIpAndLogin.release(nameKey);
      limits.loginByIp.release(address);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // A success also clears the rest of this name's own history, or
        // signing in to one real account would buy fresh guesses at every
        // other name sharing the address.
        limits.loginByIpAndLogin.reset(nameKey);
      }
    });
    res.on('close', () => {
      // An abort stays counted and never earns the success reset, even should
      // a late 'finish' follow: the handler still runs argon2 after the client
      // left, so a refund would allow unlimited argon2 work per address.
      settled = true;
    });
    next();
  };
}
