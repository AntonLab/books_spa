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
import { hashToken } from './tokens.ts';
import type { RegisterInput } from './types/auth.ts';
import { ForbiddenError, UnauthorizedError } from './types/errors.ts';

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
      return { id: opened.length, userId, expiresAt };
    },
    async createIfCredentialCurrent(
      userId: number,
      tokenHash: string,
      _expiresAt: Date,
      verifiedPasswordHash: string,
      replacedTokenHash: string | null
    ): Promise<SessionOpening> {
      replaced.push(replacedTokenHash);
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

  return { module, opened, replaced, touched, calls, created, verified };
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
  const { user, token } = await s.module.login(input, null);
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
  const { user, token } = await s.module.register({
    ...registration,
    role: 'author',
  });
  assert.deepEqual(s.created, [
    { input: { ...registrationWithoutRole, status: 'active' }, role: 'author' },
  ]);
  assert.equal(user.id, 7);
  assert.deepEqual(s.opened, [hashToken(token)]);
  assert.deepEqual(s.replaced, []); // createIfCredentialCurrent not used
});
