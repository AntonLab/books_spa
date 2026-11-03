import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { PublicUser } from 'shared';
import type { AccountSession } from '../accountSession.ts';
import { createAuthController } from './authController.ts';
import type { SessionRepository } from '../repositories/sessionRepository.ts';
import type { UserRepository } from '../repositories/userRepository.ts';
import { AppError, UnauthorizedError } from '../types/errors.ts';

const user: PublicUser = {
  id: 7,
  login: 'Racer',
  email: 'racer@example.com',
  firstName: 'Race',
  lastName: 'Er',
  status: 'active',
  role: 'user',
  avatarUrl: null,
  about: '',
  showLastSeen: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

// The controller reaches neither repository on these paths; an empty stub fails
// loudly if that ever stops being true.
const unusedUsers = {} as UserRepository;
const unusedSessions = {} as SessionRepository;

function build(events: string[] = [], failure?: Error) {
  const calls = {
    login: [] as Parameters<AccountSession['login']>[],
    register: [] as Parameters<AccountSession['register']>[],
    confirmReset: [] as Parameters<AccountSession['confirmReset']>[],
  };
  const accountSession: AccountSession = {
    async register(...args) {
      calls.register.push(args);
      if (failure) throw failure;
      return { user, token: 'tok' };
    },
    async login(...args) {
      calls.login.push(args);
      if (failure) throw failure;
      return { user, token: 'tok' };
    },
    async requestReset(email) {
      events.push(`reset ${email}`);
    },
    async confirmReset(...args) {
      calls.confirmReset.push(args);
      if (failure) throw failure;
    },
  };
  const controller = createAuthController({
    userRepository: unusedUsers,
    sessionRepository: unusedSessions,
    accountSession,
  });
  return { controller, calls };
}

function loginRequest(login: string, password: string): Request {
  return {
    validated: { body: { login, password } },
    cookies: {},
  } as unknown as Request;
}

function resetRequest(email: string): Request {
  return { validated: { body: { email } } } as unknown as Request;
}

function recordingResponse() {
  const cookies: string[] = [];
  const sent: { status?: number; json?: unknown; ended: boolean } = {
    ended: false,
  };
  const response = {
    cookie(name: string) {
      cookies.push(name);
      return response;
    },
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.json = body;
      return response;
    },
    end() {
      sent.ended = true;
      return response;
    },
  } as unknown as Response;
  return { response, cookies, sent };
}

function resetResponse(events: string[]) {
  const response = {
    status(code: number) {
      events.push(`status ${code}`);
      return response;
    },
    end() {
      events.push('end');
      return response;
    },
  } as unknown as Response;
  return response;
}

test('login passes the body and the sid cookie to the module, then sets sid and xsrfToken', async () => {
  const { controller, calls } = build();
  const request = loginRequest('Racer', 'whatever12345');
  request.cookies = { sid: 'previous-token' };
  const { response, cookies } = recordingResponse();
  await controller.login(request, response);
  assert.deepEqual(calls.login, [
    [{ login: 'Racer', password: 'whatever12345' }, 'previous-token'],
  ]);
  assert.deepEqual(cookies, ['sid', 'xsrfToken']);
});

for (const cookie of ['', ['a'], { x: 1 }, undefined]) {
  test(`login treats a sid cookie of ${JSON.stringify(cookie)} as no previous session`, async () => {
    const { controller, calls } = build();
    const request = loginRequest('Racer', 'whatever12345');
    request.cookies = { sid: cookie };
    await controller.login(request, recordingResponse().response);
    assert.equal(calls.login[0]?.[1], null);
  });
}

test('a module error from login reaches the caller and sets no cookie', async () => {
  const failure = new UnauthorizedError('Invalid credentials');
  const { controller } = build([], failure);
  const { response, cookies } = recordingResponse();
  await assert.rejects(
    async () =>
      controller.login(loginRequest('Racer', 'whatever12345'), response),
    (error: unknown) => error === failure
  );
  assert.deepEqual(cookies, []);
});

test('register sets the cookies and answers 201', async () => {
  const { controller, calls } = build();
  const body = {
    login: 'Racer',
    email: 'racer@example.com',
    password: 'whatever12345',
    firstName: 'Race',
    lastName: 'Er',
  };
  const request = { validated: { body } } as unknown as Request;
  const { response, cookies, sent } = recordingResponse();
  await controller.register(request, response);
  assert.deepEqual(calls.register, [[body]]);
  assert.deepEqual(cookies, ['sid', 'xsrfToken']);
  assert.equal(sent.status, 201);
  assert.equal((sent.json as { login: string }).login, 'Racer');
});

test('a reset request answers 202 before the module is called, which gets the email', async () => {
  const events: string[] = [];
  const { controller } = build(events);
  await controller.requestReset(
    resetRequest('racer@example.com'),
    resetResponse(events)
  );
  assert.deepEqual(events, ['status 202', 'end', 'reset racer@example.com']);
});

test('confirmReset answers 204 and passes token and password on; a module error propagates', async () => {
  const request = {
    validated: { body: { token: 'the-token', password: 'newpassword123' } },
  } as unknown as Request;

  const ok = build();
  const { response, sent } = recordingResponse();
  await ok.controller.confirmReset(request, response);
  assert.deepEqual(ok.calls.confirmReset, [['the-token', 'newpassword123']]);
  assert.equal(sent.status, 204);
  assert.equal(sent.ended, true);

  const failure = new AppError('Reset token is invalid or has expired', 400);
  const failing = build([], failure);
  await assert.rejects(
    async () =>
      failing.controller.confirmReset(request, recordingResponse().response),
    (error: unknown) => error === failure
  );
});
