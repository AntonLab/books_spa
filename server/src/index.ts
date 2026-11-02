import { createApp } from './app.ts';
import { startAnnouncementPass } from './announcements/announcementPass.ts';
import { createMailDelivery } from './delivery/mailDelivery.ts';
import { loadConfig } from './db/config.ts';
import { ensureDatabase } from './db/ensureDatabase.ts';
import { createSequelize } from './db/sequelize.ts';
import { startExpiryPurge } from './expiryPurge.ts';
import { logger, messageOf } from './logger.ts';
import { createAuthRateLimits } from './middleware/authRateLimit.ts';
import { initModels } from './models/index.ts';
import { createOnlineRegistry } from './online/onlineRegistry.ts';
import { setNotificationPublisher } from './online/notificationPublisher.ts';
import { syncPermissions } from './permissions/permissionStore.ts';
import { createSequelizeAnnouncementRepository } from './repositories/announcementRepository.ts';
import { createSequelizeRepositories } from './repositories/sequelizeRepositories.ts';
import {
  createShutdown,
  registerShutdownSignals,
  type ShutdownDeps,
} from './shutdown.ts';

function loadLocalEnv(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    logger.warn('.env.local not found; relying on the ambient environment');
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();

  // Sequelize cannot create its own schema, and creating one is not the
  // application's business in production.
  if (config.env !== 'production') {
    await ensureDatabase(config.db);
  }

  const sequelize = createSequelize(config.db);
  // Filled as each stoppable starts, so a later startup failure still stops it.
  const stoppables: ShutdownDeps['stoppables'][number][] = [];
  const shutdownDeps: ShutdownDeps = {
    sequelize,
    stoppables,
    exit: (code) => process.exit(code),
  };
  const shutdown = createShutdown(shutdownDeps);
  registerShutdownSignals(shutdown);

  try {
    initModels(sequelize);

    // A rejection here stops the process: never continue into a server with no
    // database.
    await sequelize.authenticate();

    // Creates missing tables and never alters an existing one: a model change
    // reaches a database through /db-reset (ADR-0016).
    await sequelize.sync();

    // The matrix is reference data derived from code, so it is written on every
    // boot and read back into memory. Requests do not depend on this — the store
    // already answers from the code before any sync — but it is still the call
    // that notices a missing `permissions` table. That means the schema was
    // never provisioned, and failing loudly at boot beats discovering it later.
    await syncPermissions();

    // A signal during the awaits above already closed the pool; nothing below
    // has started, so boot ends here.
    if (shutdown.stopping) return;

    const repositories = createSequelizeRepositories();
    const {
      sessionRepository,
      passwordResetRepository,
      notificationRepository,
    } = repositories;
    // After syncPermissions(): by now the schema is known to be provisioned.
    const expiryPurge = startExpiryPurge({
      sessionRepository,
      passwordResetRepository,
      notificationRepository,
    });
    stoppables.push(expiryPurge);
    const onlineRegistry = createOnlineRegistry({ sessionRepository });
    onlineRegistry.start();
    stoppables.push(onlineRegistry);
    // Credit Notifications are written inside repository transactions, which
    // know nothing of the registry; this is where the two meet.
    setNotificationPublisher((userId, notification) =>
      onlineRegistry.push(userId, notification)
    );
    const mailDelivery = createMailDelivery(config.mail);
    // After syncPermissions() like the expiry purge: the first pass runs now.
    const announcementPass = startAnnouncementPass({
      announcementRepository: createSequelizeAnnouncementRepository(),
      onlineRegistry,
      mailDelivery,
      appBaseUrl: config.appBaseUrl,
    });
    // Final stop order: expiry purge, announcement pass, online registry, rate
    // limits. The pass stops before the registry, so no pass pushes to a stream
    // the registry has just closed.
    stoppables.splice(stoppables.indexOf(onlineRegistry), 0, announcementPass);
    const authRateLimits = createAuthRateLimits();
    stoppables.push(authRateLimits);

    const app = createApp({
      ...repositories,
      mailDelivery,
      appBaseUrl: config.appBaseUrl,
      onlineRegistry,
      trustedOrigin: config.appBaseUrl,
      trustProxy: config.trustProxy,
      authRateLimits,
    });
    // Express 5 hands this callback the bind error (EADDRINUSE); Express 4 never
    // did, so code written for it logs "listening" for a server that never
    // started. The bind failure takes the shutdown path: the pool closes and
    // the process exits 1.
    shutdownDeps.server = app.listen(config.port, (error) => {
      if (error) {
        logger.error('Could not start the HTTP server', error.message);
        process.exitCode = 1;
        void shutdown('the HTTP server could not start');
        return;
      }
      logger.info(`server listening on http://127.0.0.1:${config.port}`);
    });
  } catch (error) {
    reportFatal(error);
    await shutdown('startup failed');
  }
}

function reportFatal(error: unknown): void {
  logger.error('Fatal error during startup', messageOf(error));
  process.exitCode = 1;
}

await main().catch(reportFatal);
