import type { Express } from 'express';
import { createApp } from './app.ts';
import { startAnnouncementPass } from './announcements/announcementPass.ts';
import { createMailDelivery } from './delivery/mailDelivery.ts';
import { startExpiryPurge } from './expiryPurge.ts';
import { createAuthRateLimits } from './middleware/authRateLimit.ts';
import { setNotificationPublisher } from './online/notificationPublisher.ts';
import { createOnlineRegistry } from './online/onlineRegistry.ts';
import type { AnnouncementRepository } from './repositories/announcementRepository.ts';
import type { Repositories } from './repositories/sequelizeRepositories.ts';

export interface StartServerDeps {
  repositories: Repositories;
  announcementRepository: AnnouncementRepository;
  mailConfig: Parameters<typeof createMailDelivery>[0];
  appBaseUrl: string;
  trustProxy: number;
  startExpiryPurge: typeof startExpiryPurge;
  createOnlineRegistry: typeof createOnlineRegistry;
  startAnnouncementPass: typeof startAnnouncementPass;
  createMailDelivery: typeof createMailDelivery;
  createAuthRateLimits: typeof createAuthRateLimits;
  createApp: typeof createApp;
  setNotificationPublisher: typeof setNotificationPublisher;
}

export interface StartedServer {
  app: Express;
  stop(): void;
}

interface Parts {
  expiryPurge?: { stop(): void };
  announcementPass?: { stop(): void };
  onlineRegistry?: { stop(): void };
  authRateLimits?: { stop(): void };
}

// Builds the background parts and the app. On failure, stops the parts already
// started and rethrows.
export function startServer(deps: StartServerDeps): StartedServer {
  const parts: Parts = {};

  // Final stop order: expiry purge, announcement pass, online registry, rate
  // limits. The pass stops before the registry, so no pass pushes to a stream
  // the registry has just closed. Every part is attempted; the first error
  // is rethrown after the last.
  function stopAll(): void {
    const ordered = [
      parts.expiryPurge,
      parts.announcementPass,
      parts.onlineRegistry,
      parts.authRateLimits,
    ];
    let firstError: unknown;
    let failed = false;
    for (const part of ordered) {
      try {
        part?.stop();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (failed) throw firstError;
  }

  try {
    const {
      sessionRepository,
      passwordResetRepository,
      notificationRepository,
    } = deps.repositories;
    parts.expiryPurge = deps.startExpiryPurge({
      sessionRepository,
      passwordResetRepository,
      notificationRepository,
    });
    const onlineRegistry = deps.createOnlineRegistry({ sessionRepository });
    // Set before start() so a throwing start() still stops the registry.
    parts.onlineRegistry = onlineRegistry;
    onlineRegistry.start();
    // Credit Notifications are written inside repository transactions, which
    // know nothing of the registry; this is where the two meet.
    deps.setNotificationPublisher((userId, notification) =>
      onlineRegistry.push(userId, notification)
    );
    const mailDelivery = deps.createMailDelivery(deps.mailConfig);
    // After the registry start: the first pass runs now and pushes to it.
    parts.announcementPass = deps.startAnnouncementPass({
      announcementRepository: deps.announcementRepository,
      onlineRegistry,
      mailDelivery,
      appBaseUrl: deps.appBaseUrl,
    });
    const authRateLimits = deps.createAuthRateLimits();
    parts.authRateLimits = authRateLimits;

    const app = deps.createApp({
      ...deps.repositories,
      mailDelivery,
      appBaseUrl: deps.appBaseUrl,
      onlineRegistry,
      trustedOrigin: deps.appBaseUrl,
      trustProxy: deps.trustProxy,
      authRateLimits,
    });
    return { app, stop: stopAll };
  } catch (error) {
    try {
      stopAll();
    } catch {
      // Rollback must not mask the start error.
    }
    throw error;
  }
}
