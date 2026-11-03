import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicUser, UserStatus } from 'shared';
import { createAccountSession } from './accountSession.ts';
import type { MailDelivery } from './delivery/mailDelivery.ts';
import type { PasswordResetRepository } from './repositories/passwordResetRepository.ts';
import type {
  SessionOpening,
  SessionRecord,
  SessionRepository,
} from './repositories/sessionRepository.ts';
import type { UserRepository } from './repositories/userRepository.ts';
import { SESSION_TTL_MS } from './sessionCookie.ts';
import { hashToken } from './tokens.ts';
import type { RegisterInput } from './types/auth.ts';
import { AppError, ForbiddenError, UnauthorizedError } from './types/errors.ts';
import { flushDetached } from './flush.testkit.ts';
import { recordLogs } from './logger.testkit.ts';

const BASE = 'http://localhost:3000';
const input = { login: 'Racer', password: 'whatever12345' };

const registrationWithoutRole = {
  login: 'Racer',
  email: 'racer@example.com',
  password: 'whatever12345',
  firstName: 'Race',
  lastName: 'Er',
};
const registration: RegisterInput = {
  ...registrationWithoutRole,
  role: 'user',
};

const isUnauthorized = (error: unknown) =>
  error instanceof UnauthorizedError &&
  error.statusCode === 401 &&
  error.message === 'Invalid credentials';

const isForbidden = (error: unknown) =>
  error instanceof ForbiddenError &&
  error.statusCode === 403 &&
  error.message === 'Account is blocked';

interface Account {
  id: number;
  password: string;
  status: UserStatus;
}

// One account behind both repositories login reads it through. The session
// fake re-reads the stored hash and status at the moment it opens a session,
// the way the real repository's locking read does, so a change made during the
// verify is seen.
function setup(
  options: {
    unknown?: boolean;
    status?: UserStatus;
    verifyResult?: boolean;
    verifyThrows?: boolean;
    onVerify?: (account: Account) => void;
  } = {}
) {
  const account: Account = {
    id: 7,
    password: '$argon2id$stored',
    status: options.status ?? 'active',
  };
  const opened: string[] = [];
  const expiries: Date[] = [];
  const replaced: (string | null)[] = [];
  const touched: number[] = [];
  const calls: string[] = [];
  const created: { input: unknown; role: unknown }[] = [];
  const verified: { hashed: string; plaintext: string }[] = [];

  const publicUser = (): PublicUser => ({
    id: account.id,
    login: 'Racer',
    email: 'racer@example.com',
    firstName: 'Race',
    lastName: 'Er',
    status: account.status,
    role: 'user',
    avatarUrl: null,
    about: '',
    showLastSeen: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const userRepository = {
    async findByLoginWithPassword(login: string) {
      calls.push(`login:${login}`);
      return options.unknown ? null : { ...account };
    },
    async findByEmailWithPassword(email: string) {
      calls.push(`email:${email}`);
      return options.unknown ? null : { ...account };
    },
    async findById(id: number) {
      return id === account.id ? publicUser() : null;
    },
    async touchLastSeen(id: number) {
      touched.push(id);
    },
    async create(createInput: unknown, role: unknown) {
      created.push({ input: createInput, role });
      return publicUser();
    },
  } as unknown as UserRepository;

  const sessionRepository = {
    async create(
      userId: number,
      tokenHash: string,
      expiresAt: Date
    ): Promise<SessionRecord> {
      opened.push(tokenHash);
      expiries.push(expiresAt);
      return { id: opened.length, userId, expiresAt };
    },
    async createIfCredentialCurrent(
      userId: number,
      tokenHash: string,
      expiresAt: Date,
      verifiedPasswordHash: string,
      replacedTokenHash: string | null
    ): Promise<SessionOpening> {
      replaced.push(replacedTokenHash);
      expiries.push(expiresAt);
      if (userId !== account.id || account.password !== verifiedPasswordHash) {
        return 'credential-changed';
      }
      if (account.status === 'blocked') return 'blocked';
      opened.push(tokenHash);
      return 'created';
    },
  } as unknown as SessionRepository;

  const module = createAccountSession({
    userRepository,
    sessionRepository,
    passwordResetRepository: {} as unknown as PasswordResetRepository,
    mailDelivery: {} as unknown as MailDelivery,
    appBaseUrl: BASE,
    verify: async (hashed, plaintext) => {
      verified.push({ hashed, plaintext });
      options.onVerify?.(account);
      if (options.verifyThrows) throw new Error('argon2 failed');
      return options.verifyResult ?? true;
    },
  });

  return {
    module,
    opened,
    expiries,
    replaced,
    touched,
    calls,
    created,
    verified,
  };
}

function assertSessionTtl(expiresAt: Date | undefined, before: number) {
  const ttl = (expiresAt?.getTime() ?? 0) - before;
  assert.ok(ttl >= SESSION_TTL_MS && ttl < SESSION_TTL_MS + 5_000);
}

test('an unknown login spends one verify on a dummy argon2 hash and answers 401', async () => {
  const s = setup({ unknown: true });
  await assert.rejects(s.module.login(input, null), isUnauthorized);
  assert.equal(s.verified.length, 1);
  assert.match(s.verified[0]?.hashed ?? '', /^\$argon2id\$/);
  assert.deepEqual(s.opened, []);
});

test('concurrent and repeated unknown logins verify against the same cached dummy hash', async () => {
  const s = setup({ unknown: true });
  await Promise.allSettled([
    s.module.login(input, null),
    s.module.login(input, null),
  ]);
  await assert.rejects(s.module.login(input, null), isUnauthorized);
  assert.equal(new Set(s.verified.map((v) => v.hashed)).size, 1);
  assert.equal(s.verified.length, 3);
});

test('a value with @ is looked up by email only, one without by login only', async () => {
  const s = setup({ unknown: true });
  for (const login of ['bob@example.com', 'Bob']) {
    await assert.rejects(
      s.module.login({ login, password: 'whatever12345' }, null),
      isUnauthorized
    );
  }
  assert.deepEqual(s.calls, ['email:bob@example.com', 'login:Bob']);
  assert.equal(s.verified.length, 2); // unknown email spends a verify too
});

test('a wrong password answers 401 and opens, replaces and touches nothing', async () => {
  const s = setup({ verifyResult: false });
  await assert.rejects(s.module.login(input, 'previous'), isUnauthorized);
  assert.deepEqual(s.verified, [
    { hashed: '$argon2id$stored', plaintext: 'whatever12345' },
  ]);
  assert.deepEqual([s.opened, s.replaced, s.touched], [[], [], []]);
});

test('a blocked account with the right password is 403', async () => {
  const s = setup({ status: 'blocked' });
  await assert.rejects(s.module.login(input, null), isForbidden);
  assert.deepEqual([s.opened, s.replaced], [[], []]); // refused before any opening attempt
});

test('a blocked account with a wrong password is 401, never 403', async () => {
  const s = setup({ status: 'blocked', verifyResult: false });
  await assert.rejects(s.module.login(input, null), isUnauthorized);
});

test('login returns the user and a token whose hash is the stored session', async () => {
  const s = setup();
  const before = Date.now();
  const { user, token } = await s.module.login(input, null);
  assertSessionTtl(s.expiries[0], before);
  assert.equal(user.id, 7);
  assert.deepEqual(s.opened, [hashToken(token)]);
  assert.deepEqual(s.touched, [7]);
  assert.deepEqual(s.replaced, [null]);
});

test('login passes the hash of the previous session token on', async () => {
  const s = setup();
  await s.module.login(input, 'previous-token');
  assert.deepEqual(s.replaced, [hashToken('previous-token')]);
});

test('a verify that throws rejects the login and opens nothing', async () => {
  const s = setup({ verifyThrows: true });
  await assert.rejects(s.module.login(input, null), /argon2 failed/);
  assert.deepEqual([s.opened, s.touched], [[], []]);
});

test('a password change committed during the verify leaves no session (401)', async () => {
  const s = setup({
    onVerify: (a) => {
      a.password = '$argon2id$changed';
    },
  });
  await assert.rejects(s.module.login(input, null), isUnauthorized);
  assert.deepEqual([s.opened, s.touched], [[], []]);
});

test('a block committed during the verify leaves no session (403)', async () => {
  const s = setup({
    onVerify: (a) => {
      a.status = 'blocked';
    },
  });
  await assert.rejects(s.module.login(input, null), isForbidden);
  assert.deepEqual([s.opened, s.touched], [[], []]);
});

test('register creates an active account with the role as its own argument and opens a session with create()', async () => {
  const s = setup();
  const before = Date.now();
  const { user, token } = await s.module.register({
    ...registration,
    role: 'author',
  });
  assertSessionTtl(s.expiries[0], before);
  assert.deepEqual(s.created, [
    { input: { ...registrationWithoutRole, status: 'active' }, role: 'author' },
  ]);
  assert.equal(user.id, 7);
  assert.deepEqual(s.opened, [hashToken(token)]);
  assert.deepEqual(s.replaced, []); // createIfCredentialCurrent not used
});

function resetSetup(
  events: string[],
  overrides: {
    writeFails?: boolean;
    lookupFails?: boolean;
    mailFails?: boolean;
    redeems?: boolean;
  } = {}
) {
  const known = { id: 7, email: 'racer@example.com' };
  const replaceCalls: { userId: number; tokenHash: string; expiresAt: Date }[] =
    [];
  const redeemCalls: { tokenHash: string; password: string }[] = [];
  const module = createAccountSession({
    userRepository: {
      async findByEmail(email: string) {
        events.push('lookup');
        // MySQL data errors quote the offending value, the address included
        if (overrides.lookupFails) {
          throw new Error(
            `Incorrect string value for column 'email': '${email}'`
          );
        }
        return email === known.email ? known : null;
      },
    } as unknown as UserRepository,
    sessionRepository: {} as unknown as SessionRepository,
    passwordResetRepository: {
      async replaceForUser(userId: number, tokenHash: string, expiresAt: Date) {
        events.push('replace');
        replaceCalls.push({ userId, tokenHash, expiresAt });
        if (overrides.writeFails) throw new Error('write down');
      },
      async redeem(tokenHash: string, password: string) {
        redeemCalls.push({ tokenHash, password });
        return overrides.redeems ?? false;
      },
    } as unknown as PasswordResetRepository,
    mailDelivery: {
      async send() {
        events.push('send');
        if (overrides.mailFails) throw new Error('smtp down');
      },
    },
    appBaseUrl: BASE,
    verify: async () => true,
  });
  return {
    module,
    replaceCalls,
    redeemCalls,
    requestReset: module.requestReset,
  };
}

test('requestReset does no account work before the first tick', async () => {
  const events: string[] = [];
  const p = resetSetup(events).requestReset('racer@example.com');
  assert.deepEqual(events, []);
  await p;
  assert.deepEqual(events, ['lookup', 'replace', 'send']);
});

test('an unknown address looks up and does no token work', async () => {
  const events: string[] = [];
  await resetSetup(events).requestReset('nobody@example.com');
  assert.deepEqual(events, ['lookup']);
});

test('the token written expires in one hour (3_600_000 ms, within 5 s)', async () => {
  const r = resetSetup([]);
  const before = Date.now();
  await r.module.requestReset('racer@example.com');
  const [call] = r.replaceCalls;
  assert.equal(call?.userId, 7);
  const ttl = (call?.expiresAt.getTime() ?? 0) - before;
  assert.ok(ttl >= 3_600_000 && ttl < 3_605_000);
});

for (const [name, overrides] of [
  ['a token write', { writeFails: true }],
  ['a lookup', { lookupFails: true }],
] as const) {
  test(`${name} that fails is logged by name only and never rejects`, async (t) => {
    const lines = recordLogs(t);
    const events: string[] = [];
    await resetSetup(events, overrides).requestReset('racer@example.com');
    assert.equal(events.includes('send'), false);
    assert.deepEqual(lines, [
      {
        level: 'error',
        message: 'Password reset request failed',
        meta: { error: 'Error' },
      },
    ]);
    assert.equal(JSON.stringify(lines).includes('racer@example.com'), false);
  });
}

test('a rejected mail send is logged once, requestReset still resolves, no address in the line', async (t) => {
  const lines = recordLogs(t);
  await resetSetup([], { mailFails: true }).requestReset('racer@example.com');
  await flushDetached();
  assert.deepEqual(lines, [
    {
      level: 'error',
      message: 'Password reset mail failed',
      meta: { userId: 7, error: 'smtp down' },
    },
  ]);
});

test('confirmReset redeems the hash of the token with the new password', async () => {
  const r = resetSetup([], { redeems: true });
  await r.module.confirmReset('the-token', 'newpassword123');
  assert.deepEqual(r.redeemCalls, [
    { tokenHash: hashToken('the-token'), password: 'newpassword123' },
  ]);
});

test('an unknown, expired or used token is one 400 AppError', async () => {
  const r = resetSetup([], { redeems: false });
  await assert.rejects(
    r.module.confirmReset('t', 'newpassword123'),
    (e: unknown) =>
      e instanceof AppError &&
      e.statusCode === 400 &&
      e.message === 'Reset token is invalid or has expired'
  );
});
