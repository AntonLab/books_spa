import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getNotificationSettings,
  listNotifications,
  markNotificationsRead,
  updateNotificationSettings,
} from '../api/notifications';
import type { NotificationList, NotificationSettings } from '../types/api';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

// How often an open tab asks again. A notification is written when someone
// else changes a work's credits, which nothing on this page would otherwise
// learn about.
const NOTIFICATIONS_REFETCH_MS = 60_000;

// Keyed by the account, so signing in as someone else never shows the last
// account's notifications from the cache. Unlike every other query here it
// also refetches when the window regains focus: coming back to the tab is when
// a new one is most likely to be waiting.
export const useNotifications = (userId: number) => {
  return useQuery({
    queryKey: queryKeys.notifications(userId),
    queryFn: () => listNotifications(),
    refetchInterval: NOTIFICATIONS_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
};

export const useMarkNotificationsRead = (userId: number) => {
  const queryClient = useQueryClient();
  const key = queryKeys.notifications(userId);

  return useMutation({
    mutationFn: (ids: number[]) => markNotificationsRead(ids),
    onSuccess: ({ unread }) => {
      // The count first, so the badge drops at once; the refetch then brings
      // each notification's own read flag.
      queryClient.setQueryData<NotificationList>(key, (previous) =>
        previous ? { ...previous, unread } : previous
      );
      void applyChange(queryClient, { type: 'notificationsChanged', userId });
    },
  });
};

export const useNotificationSettings = () => {
  return useQuery({
    queryKey: queryKeys.notificationSettings,
    queryFn: () => getNotificationSettings(),
  });
};

// The PATCH answers the stored settings, so they go straight into the cache
// instead of costing a refetch.
export const useUpdateNotificationSettings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: NotificationSettings) =>
      updateNotificationSettings(settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.notificationSettings, settings);
    },
  });
};
