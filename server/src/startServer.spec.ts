import test from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import type { PublicNotification } from 'shared';
import type { AppDeps } from './app.ts';
import { startServer, type StartServerDeps } from './startServer.ts';

interface HarnessOptions {
  failAt?: 'createApp' | 'start' | 'startAnnouncementPass';
  // The call strings of the stops that throw, e.g. ['pass.stop'].
  failStopOf?: string[];
}

interface Harness {
  deps: StartServerDeps;
  // Every call the server made on its collaborators, in order.
  calls: string[];
  pushes: Array<[number, PublicNotification]>;
  // The function given to setNotificationPublisher.
  publisher(): ((userId: number, n: PublicNotification) => void) | null;
  appDeps(): AppDeps | undefined;
  registry: object;
  limits: object;
  mail: object;
  app: Express;
}

// Fakes for every factory: no timer, socket or database. Tests see only call
// order and arguments.
function harness(opts: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const pushes: Array<[number, PublicNotification]> = [];
  let publisher: ((userId: number, n: PublicNotification) => void) | null =
    null;
  let appDeps: AppDeps | undefined;

  function part(stopCall: string) {
    return {
      stop() {
        calls.push(stopCall);
        if (opts.failStopOf?.includes(stopCall))
          throw new Error(`${stopCall} failed`);
      },
    };
  }

  const registry = {
    ...part('registry.stop'),
    start() {
      calls.push('registry.start');
      if (opts.failAt === 'start') throw new Error('boom');
    },
    push(userId: number, n: PublicNotification) {
      pushes.push([userId, n]);
    },
  };
  const limits = part('limits.stop');
  const mail = {};
  const app = {} as unknown as Express;

  const deps = {
    repositories: { sessionRepository: {} } as never,
    announcementRepository: {} as never,
    mailConfig: {} as never,
    appBaseUrl: 'http://app.test',
    trustProxy: 2,
    startExpiryPurge() {
      calls.push('purge.start');
      return part('purge.stop');
    },
    createOnlineRegistry() {
      calls.push('registry.create');
      return registry;
    },
    setNotificationPublisher(next: typeof publisher) {
      calls.push('publisher.set');
      publisher = next;
    },
    createMailDelivery() {
      calls.push('mail.create');
      return mail;
    },
    startAnnouncementPass() {
      calls.push('pass.start');
      if (opts.failAt === 'startAnnouncementPass') throw new Error('boom');
      return part('pass.stop');
    },
    createAuthRateLimits() {
      calls.push('limits.create');
      return limits;
    },
    createApp(given: AppDeps) {
      calls.push('app.create');
      appDeps = given;
      if (opts.failAt === 'createApp') throw new Error('boom');
      return app;
    },
  } as unknown as StartServerDeps;

  return {
    deps,
    calls,
    pushes,
    publisher: () => publisher,
    appDeps: () => appDeps,
    registry,
    limits,
    mail,
    app,
  };
}

const STOP_ORDER = ['purge.stop', 'pass.stop', 'registry.stop', 'limits.stop'];

test('stop() stops expiry purge, announcement pass, online registry, rate limits in that order', () => {
  const h = harness();
  const started = startServer(h.deps);
  h.calls.length = 0;
  started.stop();
  assert.deepEqual(h.calls, STOP_ORDER);
});

test('the announcement pass starts after onlineRegistry.start()', () => {
  const h = harness();
  startServer(h.deps);
  assert.ok(h.calls.indexOf('registry.start') < h.calls.indexOf('pass.start'));
  assert.ok(
    h.calls.indexOf('purge.start') < h.calls.indexOf('registry.create')
  );
  assert.ok(h.calls.indexOf('pass.start') < h.calls.indexOf('app.create'));
});

test('the publisher is wired to onlineRegistry.push', () => {
  const h = harness();
  startServer(h.deps);
  const notification = { id: 7 } as unknown as PublicNotification;
  h.publisher()!(42, notification);
  assert.deepEqual(h.pushes, [[42, notification]]);
});

test('createApp receives the repositories, mail delivery, registry and rate limits that stop() later stops', () => {
  const h = harness();
  const started = startServer(h.deps);
  const given = h.appDeps()!;
  assert.equal(given.appBaseUrl, 'http://app.test');
  assert.equal(given.trustedOrigin, 'http://app.test');
  assert.equal(given.trustProxy, 2);
  assert.equal(given.sessionRepository, h.deps.repositories.sessionRepository);
  assert.equal(given.onlineRegistry, h.registry);
  assert.equal(given.authRateLimits, h.limits);
  assert.equal(given.mailDelivery, h.mail);
  assert.equal(started.app, h.app);
});

test('a createApp failure stops what exists in stop order and rethrows', () => {
  const h = harness({ failAt: 'createApp' });
  assert.throws(() => startServer(h.deps), /boom/);
  assert.deepEqual(
    h.calls.slice(h.calls.indexOf('app.create') + 1),
    STOP_ORDER
  );
});

test('a failure in onlineRegistry.start() stops only the purge and the registry', () => {
  const h = harness({ failAt: 'start' });
  assert.throws(() => startServer(h.deps), /boom/);
  assert.deepEqual(h.calls.slice(h.calls.indexOf('registry.start') + 1), [
    'purge.stop',
    'registry.stop',
  ]);
  assert.ok(!h.calls.includes('pass.start'));
  assert.ok(!h.calls.includes('limits.create'));
});

test('a failure in the first factory stops nothing and rethrows the same error', () => {
  const h = harness();
  const boom = new Error('boom');
  h.deps.startExpiryPurge = () => {
    h.calls.push('purge.start');
    throw boom;
  };
  assert.throws(
    () => startServer(h.deps),
    (error) => error === boom
  );
  assert.ok(!h.calls.some((call) => call.endsWith('.stop')));
});

test('a stop that throws during rollback does not replace the start error', () => {
  const h = harness({ failAt: 'createApp', failStopOf: ['pass.stop'] });
  assert.throws(() => startServer(h.deps), /boom/);
  assert.deepEqual(
    h.calls.slice(h.calls.indexOf('app.create') + 1),
    STOP_ORDER
  );
});

for (const { title, failStopOf } of [
  {
    title:
      'a throwing stop() still stops the later parts and rethrows the first error',
    failStopOf: ['pass.stop'],
  },
  {
    title: 'when two stops throw, stop() rethrows the first error',
    failStopOf: ['pass.stop', 'registry.stop'],
  },
]) {
  test(title, () => {
    const h = harness({ failStopOf });
    const started = startServer(h.deps);
    h.calls.length = 0;
    assert.throws(() => started.stop(), /pass\.stop failed/);
    assert.deepEqual(h.calls, STOP_ORDER);
  });
}

test("stop() twice calls every part's stop again without throwing", () => {
  const h = harness();
  const started = startServer(h.deps);
  started.stop();
  h.calls.length = 0;
  assert.doesNotThrow(() => started.stop());
  assert.deepEqual(h.calls, STOP_ORDER);
});
