// A fixed-window rate limiter kept in memory. No dependency and no database:
// counts live in this process only, and a restart forgets them.

interface RateLimitState {
  // Whether this request is within the limit.
  allowed: boolean;
  // Milliseconds until the key's window closes.
  retryAfterMs: number;
}

export interface RateLimiter {
  // Counts one request against the key and reports the state after it.
  hit(key: string): RateLimitState;
  // Gives back one hit that turned out not to count. Floors at 0 and deletes
  // the key at 0, so counted-then-released requests cannot grow the map.
  // The window's end does not move while the count stays above 0.
  // A no-op when the key holds no open window.
  release(key: string): void;
  // Forgets the key's window.
  reset(key: string): void;
  // How many keys the map still holds, an ended window included until a
  // touch or the sweep drops it — what the sweep keeps bounded.
  size(): number;
  // Clears the sweep's interval.
  stop(): void;
}

interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

interface Window {
  count: number;
  endsAt: number;
}

export function createRateLimiter({
  limit,
  windowMs,
}: RateLimiterOptions): RateLimiter {
  const windows = new Map<string, Window>();

  // The lazy half of the cleanup: a window is dropped the moment its key is
  // touched after it ended.
  const current = (key: string, at: number): Window | undefined => {
    const window = windows.get(key);
    if (window !== undefined && window.endsAt <= at) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  // The other half: keys never touched again are swept once a window, so
  // memory stays bounded by the keys seen in one window. unref() so the
  // interval never holds the process open.
  const sweep = (): void => {
    const at = Date.now();
    for (const [key, window] of windows) {
      if (window.endsAt <= at) {
        windows.delete(key);
      }
    }
  };
  const timer = setInterval(sweep, windowMs);
  timer.unref();

  return {
    hit(key) {
      const at = Date.now();
      const window = current(key, at);
      const next: Window = {
        count: (window?.count ?? 0) + 1,
        endsAt: window?.endsAt ?? at + windowMs,
      };
      windows.set(key, next);
      return { allowed: next.count <= limit, retryAfterMs: next.endsAt - at };
    },

    release(key) {
      const at = Date.now();
      const window = current(key, at);
      if (window === undefined) {
        return;
      }
      const count = Math.max(0, window.count - 1);
      if (count === 0) {
        windows.delete(key);
        return;
      }
      windows.set(key, { count, endsAt: window.endsAt });
    },

    reset(key) {
      windows.delete(key);
    },

    size: () => windows.size,

    stop() {
      clearInterval(timer);
    },
  };
}
