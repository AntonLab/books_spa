import { useEffect, useEffectEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { openNotificationStream } from '../api/notificationStream';
import type { PublicNotification } from '../types/api';
import { applyChange } from './applyChange';

// How long to wait before opening a stream again once the browser has given
// up on one. Long enough that a server that keeps refusing is not hammered;
// the bell's 60 s polling covers the gap.
export const NOTIFICATION_STREAM_RETRY_MS = 30_000;

// Keeps the Account's notification stream open while the caller is mounted.
// The caller is NotificationBell, which is mounted exactly while an Account is
// signed in: Sign out and a Lost session unmount it, and the cleanup below
// closes the stream.
export const useNotificationStream = (
  userId: number,
  onNotification: (notification: PublicNotification) => void
): void => {
  const queryClient = useQueryClient();
  // An effect event, so a new callback each render does not reopen the stream.
  const handleNotification = useEffectEvent(onNotification);

  useEffect(() => {
    let close = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      close = openNotificationStream({
        onNotification: (notification) => {
          void applyChange(queryClient, {
            type: 'notificationsChanged',
            userId,
          });
          handleNotification(notification);
        },
        // Most often the session has ended: asking /auth/me again turns that
        // into a Lost session, which unmounts the caller and cancels the
        // retry. Otherwise the server was briefly away, and one more try
        // follows after the delay.
        onClosed: () => {
          void applyChange(queryClient, { type: 'sessionStale' });
          retry = setTimeout(open, NOTIFICATION_STREAM_RETRY_MS);
        },
      });
    };

    open();
    return () => {
      clearTimeout(retry);
      close();
    };
  }, [queryClient, userId]);
};
