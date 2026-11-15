/**
 * @medidata/api — REST + FHIR API server (Express 4).
 *
 * Boots the app assembled in app.ts, validates configuration up front, and
 * shuts down gracefully (stop accepting connections → disconnect Prisma).
 */
import './env.js';
import { prisma } from '@medidata/db';
import { logger } from '@medidata/shared/logger';
import { app } from './app.js';
import { config } from './config.js';

const server = app.listen(config.API_PORT, () => {
  logger.info(
    {
      event: 'api.listen',
      port: config.API_PORT,
      env: config.NODE_ENV,
      health: '/health',
      openapi: '/openapi.json',
    },
    `[api] listening on http://localhost:${config.API_PORT}`,
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: 'api.shutdown', signal }, `[api] ${signal} received — shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

export { server };
