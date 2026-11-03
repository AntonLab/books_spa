import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  AUTH_RATE_LIMITS,
  createAuthRateLimits,
  limitEveryRequest,
  limitEveryRequestByUser,
  limitFailedLogins,
} from './authRateLimit.ts';
import { errorHandler } from './errorHandler.ts';
import { TooManyRequestsError } from '../types/errors.ts';

const CLIENT = '203.0.113.10';
const OTHER_CLIENT = '203.0.113.20';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

interface Client {
  // POST /login; the stand-in handler answers with `status`.
  login(login: string, status: number, from?: string): Promise<Response>;
  register(from?: string): Promise<Response>;
  // How many requests got past the limits to a handler.
  handled(): number;
}

// A stand-in for the auth routes: /login answers whatever status the body
// asks for, so a test decides which attempts fail; /register answers 201.
// One trusted proxy hop, so a test picks the client address through
// X-Forwarded-For. Date is mocked from 0, and `clock.now = ms` moves it by
// hand; timers stay real, so the sockets and fetch run as usual.
async function withLimitedApp(
  t: TestContext,
  fn: (client: Client, clock: { now: number }) => Promise<void>
): Promise<void> {
  t.mock.timers.enable({ apis: ['Date'] });
  const clock = {
    set now(ms: number) {
      t.mock.timers.setTime(ms);
    },
  };
  const limits = createAuthRateLimits();
  let handled = 0;

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', limitFailedLogins(limits), (req, res) => {
    handled += 1;
    const { status } = req.body as { status: number };
    res.status(status).end();
  });
  app.post('/register', limitEveryRequest(limits.register), (_req, res) => {
    handled += 1;
    res.status(201).end();
  });
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const client: Client = {
    login: (login, status, from = CLIENT) =>
      fetch(`${base}/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': from,
        },
        body: JSON.stringify({ login, password: 'irrelevant', status }),
      }),
    register: (from = CLIENT) =>
      fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'x-forwarded-for': from },
      }),
    handled: () => handled,
  };

  try {
    await fn(client, clock);
  } finally {
    limits.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Polls until `condition` holds, failing with what it was waiting for once
// the deadline passes. A fixed sleep only guesses how long the server needs,
// and under load — the server suite runs its spec files in parallel — the
// guess runs out first.
async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.fail(`Waited ${timeoutMs} ms for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface GatedClient extends Pick<Client, 'login' | 'handled'> {
  // How many requests have reached the limiter, allowed or not.
  arrived(): number;
}

// A gated variant of the /login stand-in: the handler waits on a promise the
// test controls before it answers, so many concurrent requests can be made
// to arrive — and pass or fail the limiter — before any of them is allowed
// to respond. That is what makes a check-then-record race observable on
// demand rather than by luck of scheduling.
async function withGatedLoginApp(
  fn: (client: GatedClient, release: () => void) => Promise<void>
): Promise<void> {
  const limits = createAuthRateLimits();
  let arrived = 0;
  let handled = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  // Counted just ahead of the limiter. Nothing between here and the handler
  // waits on anything, so once a request is counted here the limiter has
  // already decided it, and a request it let through has reached the handler.
  app.use((_req, _res, next) => {
    arrived += 1;
    next();
  });
  app.post('/login', limitFailedLogins(limits), (req, res) => {
    handled += 1;
    void gate.then(() => {
      const { status } = req.body as { status: number };
      res.status(status).end();
    });
  });
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const client: GatedClient = {
    login: (login, status, from = CLIENT) =>
      fetch(`${base}/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': from,
        },
        body: JSON.stringify({ login, password: 'irrelevant', status }),
      }),
    arrived: () => arrived,
    handled: () => handled,
  };

  try {
    await fn(client, releaseGate);
  } finally {
    limits.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function failTimes(
  client: Client,
  login: string,
  times: number,
  from?: string
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    assert.equal((await client.login(login, 401, from)).status, 401);
  }
}

// The message is pluralised: "1 minute." at exactly one minute, "N minutes."
// otherwise. N itself is passed in, so a caller states which form it expects.
async function assertRefused(
  response: Response,
  retryAfter: string,
  minutes: number
): Promise<void> {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), retryAfter);
  assert.deepEqual(await response.json(), {
    error: `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
  });
}

test('the budgets are 10 and 50 failed logins per 15 minutes, 5 registrations and 5 reset requests and 10 reset confirmations per hour, 5 currentPassword guesses per 15 minutes, 20 uploads and 60 writes per 15 minutes', () => {
  assert.deepEqual(AUTH_RATE_LIMITS, {
    loginByIpAndLogin: { limit: 10, windowMs: FIFTEEN_MINUTES_MS },
    loginByIp: { limit: 50, windowMs: FIFTEEN_MINUTES_MS },
    register: { limit: 5, windowMs: ONE_HOUR_MS },
    resetRequest: { limit: 5, windowMs: ONE_HOUR_MS },
    resetConfirm: { limit: 10, windowMs: ONE_HOUR_MS },
    currentPassword: { limit: 5, windowMs: FIFTEEN_MINUTES_MS },
    upload: { limit: 20, windowMs: FIFTEEN_MINUTES_MS },
    write: { limit: 60, windowMs: FIFTEEN_MINUTES_MS },
  });
});

test('the currentPassword limiter allows 5 hits per key and refuses the 6th', () => {
  const limits = createAuthRateLimits();
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(limits.currentPassword.hit('7').allowed, true);
    }
    assert.equal(limits.currentPassword.hit('7').allowed, false);
    assert.equal(limits.currentPassword.hit('8').allowed, true);
  } finally {
    limits.stop();
  }
});

test('the upload limiter allows 20 hits per key and refuses the 21st', () => {
  const limits = createAuthRateLimits();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(limits.upload.hit('7').allowed, true);
    }
    assert.equal(limits.upload.hit('7').allowed, false);
    assert.equal(limits.upload.hit('8').allowed, true);
  } finally {
    limits.stop();
  }
});

test('limitEveryRequestByUser keys by req.user.id, counts every request and refuses with Retry-After', () => {
  const limits = createAuthRateLimits();
  try {
    const handler = limitEveryRequestByUser(limits.upload);
    const run = (id: number) => {
      const headers: Record<string, string> = {};
      let passed: unknown = 'unset';
      handler(
        { user: { id } } as never,
        { setHeader: (k: string, v: string) => (headers[k] = v) } as never,
        (err?: unknown) => (passed = err)
      );
      return { passed, headers };
    };
    for (let i = 0; i < 20; i++) assert.equal(run(7).passed, undefined);
    const refused = run(7);
    assert.ok(refused.passed instanceof TooManyRequestsError);
    assert.match(refused.headers['Retry-After'] ?? '', /^\d+$/);
    assert.equal(run(8).passed, undefined);
  } finally {
    limits.stop();
  }
});

test('limitEveryRequestByUser passes a request without req.user on untouched and counts nothing', () => {
  const limits = createAuthRateLimits();
  try {
    const handler = limitEveryRequestByUser(limits.upload);
    const run = (user?: { id: number }) => {
      const calls: unknown[][] = [];
      handler(
        { user } as never,
        { setHeader: () => {} } as never,
        (...args: unknown[]) => calls.push(args)
      );
      return calls;
    };
    // More than the budget, so a counted guest would exhaust it.
    for (let i = 0; i < 25; i++) assert.deepEqual(run(), [[]]);
    // A user still has the full budget, and only that user is tracked.
    for (let i = 0; i < 20; i++) assert.deepEqual(run({ id: 7 }), [[]]);
    assert.ok(run({ id: 7 })[0]?.[0] instanceof TooManyRequestsError);
    assert.equal(limits.upload.size(), 1);
  } finally {
    limits.stop();
  }
});

test('the 11th failed login for one name from one address is refused before the handler runs', async (t) => {
  await withLimitedApp(t, async (client) => {
    await failTimes(client, 'bob', 10);

    const refused = await client.login('bob', 200);

    assert.equal(refused.status, 429);
    assert.equal(client.handled(), 10);
  });
});

test('of the answers, only a 401 spends the login budget', async (t) => {
  await withLimitedApp(t, async (client) => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      assert.equal((await client.login('bob', 400)).status, 400);
      assert.equal((await client.login('bob', 403)).status, 403);
    }

    await failTimes(client, 'bob', 10);
    assert.equal((await client.login('bob', 401)).status, 429);
  });
});

test('a successful login clears that name’s budget', async (t) => {
  await withLimitedApp(t, async (client) => {
    await failTimes(client, 'bob', 9);
    assert.equal((await client.login('bob', 200)).status, 200);

    await failTimes(client, 'bob', 10);
    assert.equal((await client.login('bob', 401)).status, 429);
  });
});

test('the 51st failure from one address is refused whatever the name, and a success does not clear it', async (t) => {
  await withLimitedApp(t, async (client) => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await failTimes(client, name, 10);
    }
    await failTimes(client, 'e', 9);
    // Clears e's own budget only: 49 failures still stand against the address.
    assert.equal((await client.login('e', 200)).status, 200);
    await failTimes(client, 'f', 1);

    assert.equal((await client.login('g', 401)).status, 429);
    assert.equal((await client.login('g', 401, OTHER_CLIENT)).status, 401);
  });
});

test('names are compared trimmed and lower-cased', async (t) => {
  await withLimitedApp(t, async (client) => {
    await failTimes(client, 'Bob', 10);

    assert.equal((await client.login('  bob ', 401)).status, 429);
  });
});

test('each address keeps its own budget', async (t) => {
  await withLimitedApp(t, async (client) => {
    await failTimes(client, 'bob', 10);

    assert.equal((await client.login('bob', 401, OTHER_CLIENT)).status, 401);
  });
});

test('a refusal says how long to wait: Retry-After in whole seconds, rounded up, the message in minutes', async (t) => {
  await withLimitedApp(t, async (client, clock) => {
    await failTimes(client, 'bob', 10);

    // 599,999 ms of the window are left.
    clock.now = 300_001;
    await assertRefused(await client.login('bob', 401), '600', 10);
  });
});

test('the message never promises less than a minute, and one minute is singular', async (t) => {
  await withLimitedApp(t, async (client, clock) => {
    await failTimes(client, 'bob', 10);

    // One second of the window is left.
    clock.now = FIFTEEN_MINUTES_MS - 1_000;
    await assertRefused(await client.login('bob', 401), '1', 1);
  });
});

test('when both login budgets refuse, the refusal names the longer wait', async (t) => {
  await withLimitedApp(t, async (client, clock) => {
    // The address's window opens at 0 and bob's at 10 minutes. Once the
    // address's window has closed, 50 fresh failures open a new one at 15
    // minutes, so the address's window now ends after bob's: bob has 10
    // minutes left, the address 15. The longer wait is the second of the
    // two budgets checked, so neither the first refusal nor the shorter wait
    // would give it.
    await failTimes(client, 'x', 1);
    clock.now = 10 * 60 * 1000;
    await failTimes(client, 'bob', 10);
    clock.now = FIFTEEN_MINUTES_MS;
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await failTimes(client, name, 10);
    }

    await assertRefused(await client.login('bob', 401), '900', 15);
  });
});

test('the budget returns when the window ends', async (t) => {
  await withLimitedApp(t, async (client, clock) => {
    await failTimes(client, 'bob', 10);

    clock.now = FIFTEEN_MINUTES_MS - 1;
    assert.equal((await client.login('bob', 401)).status, 429);
    clock.now = FIFTEEN_MINUTES_MS;
    assert.equal((await client.login('bob', 401)).status, 401);
  });
});

test('every registration counts, and the sixth in an hour is refused', async (t) => {
  await withLimitedApp(t, async (client, clock) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await client.register()).status, 201);
    }

    await assertRefused(await client.register(), '3600', 60);
    assert.equal(client.handled(), 5);
    assert.equal((await client.register(OTHER_CLIENT)).status, 201);

    clock.now = ONE_HOUR_MS;
    assert.equal((await client.register()).status, 201);
  });
});

test('a non-401 outcome — malformed or successful — does not consume the per-IP budget', async (t) => {
  await withLimitedApp(t, async (client) => {
    // 30 malformed attempts and 30 successful logins across different names
    // from the same address: 60 requests, more than the 50-per-IP budget,
    // none of them a failed login.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal((await client.login(`bad-${attempt}`, 400)).status, 400);
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal((await client.login(`ok-${attempt}`, 200)).status, 200);
    }

    // The per-IP budget is untouched by any of that: exactly 50 genuine
    // failures still fit before the 51st is refused.
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await failTimes(client, name, 10);
    }
    assert.equal((await client.login('f', 401)).status, 429);
  });
});

test('parallel attempts cannot bypass the budget: 20 at once gets exactly 10 through, no more and no fewer', async () => {
  await withGatedLoginApp(async (client, release) => {
    // All 20 name the same login, so the binding budget is the 10-per-name
    // one. None of them can finish until the gate opens, so every one of
    // them arrives, and the limiter must decide on all 20 while none has
    // answered yet — exactly the window a check-then-record design leaves
    // open for parallel requests to share one unspent count. Exactly 10, not
    // merely "at most 10", also catches a refusal that over-counts and
    // starves the budget below what it should allow.
    const attempts = Array.from({ length: 20 }, () => client.login('bob', 401));
    try {
      // Every request reaches the limiter before any of them is allowed to
      // respond.
      await waitUntil(
        () => client.arrived() === 20,
        'all 20 attempts to reach the limiter'
      );

      // Decided already, before a single allowed attempt has answered:
      // exactly 10 were let through to the handler.
      assert.equal(client.handled(), 10);
    } finally {
      // However the assertion above comes out, every gated request is still
      // waiting on this: release it, or a failure here leaves 20 open
      // connections that keep the server from ever closing.
      release();
    }

    const statuses = (await Promise.all(attempts)).map(
      (response) => response.status
    );
    assert.equal(statuses.filter((status) => status === 401).length, 10);
    assert.equal(statuses.filter((status) => status === 429).length, 10);
  });
});

test('a refusal leaves no count behind on either budget, including the one that did not refuse it', async () => {
  // Built directly, not through withGatedLoginApp, so the test can inspect
  // both budgets' own state afterward rather than inferring it indirectly
  // through more HTTP responses.
  const limits = createAuthRateLimits();
  let handled = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', limitFailedLogins(limits), (req, res) => {
    handled += 1;
    void gate.then(() => {
      const { status } = req.body as { status: number };
      res.status(status).end();
    });
  });
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const loginAs = (login: string, status: number) =>
    fetch(`${base}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': CLIENT,
      },
      body: JSON.stringify({ login, password: 'irrelevant', status }),
    });

  try {
    // 50 different names from the same address, all held open on the gate:
    // the per-IP budget (50) is now fully claimed by in-flight requests,
    // none of them settled as a 401 yet — a budget "at its limit" only
    // because of claims still in flight, not because of 50 real failures.
    const inFlight = Array.from({ length: 50 }, (_, index) =>
      loginAs(`held-${index}`, 400)
    );
    try {
      await waitUntil(
        () => handled === 50,
        'all 50 held attempts to reach the handler'
      );
      assert.equal(handled, 50);

      // Five more attempts, each a fresh name, arrive and are refused by the
      // per-IP budget alone (their own name budget has room). If a refusal
      // left its count behind — on either budget — each of these would push
      // the address further over 50, on top of the 50 already claimed.
      const refused = await Promise.all(
        Array.from({ length: 5 }, (_, index) => loginAs(`late-${index}`, 400))
      );
      for (const response of refused) {
        assert.equal(response.status, 429);
      }
      // None of the refused attempts ever reached the handler.
      assert.equal(handled, 50);
    } finally {
      // However the assertions above come out, the 50 held requests are
      // still waiting on this: release them, or a failure here leaves 50
      // open connections that keep the server from closing.
      releaseGate();
    }

    const inFlightStatuses = (await Promise.all(inFlight)).map(
      (response) => response.status
    );
    assert.deepEqual(inFlightStatuses, Array<number>(50).fill(400));
    // None of the 50 in-flight requests was a 401, so settling them as 400
    // must free both budgets completely — back to no window at all, not
    // merely back down to 50. A residual left behind by the 5 refusals would
    // keep a window open and this would time out. The per-name budget
    // refused none of them: each refused name gave its claim back with the
    // refusal, and each held name with its 400.
    await waitUntil(
      () =>
        limits.loginByIp.size() === 0 && limits.loginByIpAndLogin.size() === 0,
      'both budgets to hold no window once every held request has settled'
    );
  } finally {
    limits.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an aborted login keeps both claims, as a 401 would, and never earns the success reset', async () => {
  const limits = createAuthRateLimits();
  let destroy: (() => void) | undefined;
  let notifyReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    notifyReady = resolve;
  });
  let notifyClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  // Only the very first request is left hanging; every one after it answers
  // normally, so the follow-up probes below get a real response.
  let captured = false;

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', limitFailedLogins(limits), (req, res) => {
    const { status } = req.body as { status: number };
    if (!captured) {
      captured = true;
      // Left open until the connection is gone: only 'close' fires for this
      // one, never 'finish'. The limiter's own 'close' listener was added
      // before this one, so by the time this runs it has already settled.
      res.on('close', () => {
        // The real handler carries on after a reset while the lookup and
        // argon2 run, then answers — here the 200 the body asked for, which
        // reaches nobody.
        res.status(status).end();
        notifyClosed();
      });
      destroy = () => res.socket?.destroy();
      notifyReady();
      return;
    }
    res.status(status).end();
  });
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const login = (status: number) =>
    fetch(`${base}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': CLIENT,
      },
      body: JSON.stringify({ login: 'bob', password: 'irrelevant', status }),
    });

  try {
    // The client sees the destroyed connection as a network error.
    const aborted = login(200).catch(() => undefined);
    await ready;
    destroy?.();
    await Promise.all([aborted, closed]);

    // Both budgets still hold the aborted attempt's claim.
    assert.equal(limits.loginByIpAndLogin.size(), 1);
    assert.equal(limits.loginByIp.size(), 1);

    // It spent one of bob's ten, as a failure would, and the 200 it asked
    // for cleared nothing: nine genuine failures later the budget is spent.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      assert.equal((await login(401)).status, 401);
    }
    assert.equal((await login(401)).status, 429);
  } finally {
    limits.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
