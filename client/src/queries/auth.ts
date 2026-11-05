import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import * as authApi from '../api/auth';
import type { LoginPayload, RegisterPayload } from 'shared';
import { ApiError } from '../api/client';
import { updateUser } from '../api/users';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';
import type { SessionUser } from '../types/api';

// `null` means "asked, and nobody is signed in"; `undefined` means "not asked
// yet". TanStack enforces the distinction for us — it rejects an `undefined`
// return from a queryFn outright — so the cache can hold the whole answer.
type Session = SessionUser | null;

interface ConfirmResetInput {
  token: string;
  password: string;
}

const setSession = (client: QueryClient, session: Session): void => {
  client.setQueryData<Session>(queryKeys.session, session);
};

// What `watchSession` needs of a `BroadcastChannel`; a test passes a fake.
interface SessionChannel {
  postMessage(message: null): void;
  addEventListener(type: 'message', listener: () => void): void;
}

const sessionHash = hashKey(queryKeys.session);

// A list key is `['books' | 'series' | 'readingLists', params]`; a detail key has a number at
// index 1 and never matches. Another user's `userId` list is public and stays.
const isAccountList = (
  queryKey: readonly unknown[],
  accountId: number | null
): boolean => {
  const [scope, params] = queryKey;
  if (
    (scope !== 'books' && scope !== 'series' && scope !== 'readingLists') ||
    typeof params !== 'object'
  ) {
    return false;
  }
  if (params === null) return false;
  const { favoritedBy, userId } = params as {
    favoritedBy?: unknown;
    userId?: unknown;
  };
  return favoritedBy === 'me' || (accountId !== null && userId === accountId);
};

// A session is a cookie every tab shares, so a sign-in or Sign out in one tab
// changes who every other tab acts as; a tab still showing the old Account
// would send its writes as the new one. Three duties, for the app's one client:
//
// - A session this tab's own mutation wrote (`setQueryData`, so `manual`) is
//   announced on the channel; a tab that hears it asks /auth/me again rather
//   than trusting the message, since the cookie is the truth. `null` where the
//   browser has no BroadcastChannel: `useSession`'s refetch on focus catches up.
// - A different Account (Guest counts as one) invalidates every other query,
//   from whichever path the change arrived: likes, Draft books and
//   notifications are answered for whoever asks.
// - A 401 on any request while this tab shows an Account is a Lost session
//   noticed mid-page: /auth/me is asked again rather than the session guessed
//   to be `null`, since a sign-in in another tab may have overtaken the
//   request. Other tabs are not told: each asks on focus anyway.
export const watchSession = (
  client: QueryClient,
  channel: SessionChannel | null
): void => {
  channel?.addEventListener('message', () => {
    void applyChange(client, { type: 'sessionStale' });
  });

  // undefined until the first answer: nothing to compare it with yet.
  let accountId: number | null | undefined;
  client.getQueryCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'success' ||
      event.query.queryHash !== sessionHash
    ) {
      return;
    }
    if (event.action.manual) channel?.postMessage(null);
    const next = (event.action.data as Session)?.id ?? null;
    if (accountId !== undefined && next !== accountId) {
      // Removed, not invalidated: they belong to the Account that left, and a
      // refetch while the bell or the Account tab's EmailNotificationsSetting
      // is still mounted would ask as the next one (a Guest's 401 on Sign out).
      // Library and Favorites are private too: the
      // next Account must not see the last one's lists while the refetch lands.
      // The Favorites and My works lists live under the shared `books` and
      // `series` prefixes, so a predicate finds them.
      client.removeQueries({ queryKey: queryKeys.allNotifications });
      client.removeQueries({ queryKey: queryKeys.allLibrary });
      client.removeQueries({ queryKey: queryKeys.allFavorites });
      client.removeQueries({ queryKey: queryKeys.allMyReadingLists });
      // Reports are for a Moderator, so a refetch as the next Account (a Guest
      // after Sign out) would answer 401; `enabled` alone does not stop it,
      // because an invalidation refetches an observer whose last render still
      // said enabled.
      client.removeQueries({ queryKey: queryKeys.allReports });
      client.removeQueries({ queryKey: queryKeys.notificationSettings });
      client.removeQueries({
        predicate: (query) => isAccountList(query.queryKey, accountId ?? null),
      });
      void applyChange(client, { type: 'accountSwitched' });
    }
    accountId = next;
  });

  const onError = (error: unknown): void => {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      client.getQueryData<Session>(queryKeys.session)
    ) {
      void applyChange(client, { type: 'sessionStale' });
    }
  };
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      onError(event.action.error);
    }
  });
  client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      onError(event.action.error);
    }
  });
};

export const useSession = () => {
  return useQuery({
    queryKey: queryKeys.session,
    // Even when fresh: a tab that missed another tab's announcement (asleep,
    // or no BroadcastChannel) catches up the moment it is looked at, and so
    // notices a session that expired or was ended by a Block.
    refetchOnWindowFocus: 'always',
    queryFn: async (): Promise<Session> => {
      try {
        return await authApi.me();
      } catch (error) {
        // A 401 means "not logged in" — the ordinary state for a first-time
        // visitor, and a success for this query. Rethrowing would flash an
        // error at every anonymous arrival.
        if (error instanceof ApiError && error.status === 401) {
          return null;
        }
        throw error;
      }
    },
  });
};

export function useSignedIn(): boolean {
  return useSession().data != null;
}

// Every mutation below writes the session with `setQueryData` rather than
// `invalidateQueries`: the response body *is* the new session, so refetching
// /auth/me would re-ask a question the response already answered.
//
// `mutationFn`s are wrapped in an arrow, not passed by reference: TanStack
// calls `mutationFn(variables, mutationFnContext)`, and a point-free reference
// would forward that internal context object to the api layer.
export const useLogin = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginPayload) => authApi.login(input),
    onSuccess: (user) => setSession(client, user),
  });
};

export const useRegister = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterPayload) => authApi.register(input),
    onSuccess: (user) => setSession(client, user),
  });
};

export const useLogout = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => setSession(client, null),
  });
};

export const useRequestReset = () => {
  return useMutation({
    mutationFn: (email: string) => authApi.requestReset(email),
  });
};

export const useConfirmReset = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ token, password }: ConfirmResetInput) =>
      authApi.confirmReset(token, password),
    // The server destroys every session for the user on a successful reset —
    // this one included — so the client must not keep showing a signed-in
    // header.
    onSuccess: () => setSession(client, null),
  });
};

export const useChangePassword = (userId: number) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { password: string; currentPassword: string }) =>
      updateUser(userId, input),
    // The server ends every session of the user, this one included, so no
    // logout request follows.
    onSuccess: () => setSession(client, null),
  });
};
