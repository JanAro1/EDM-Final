/**
 * Server-only structured logger.
 *
 * Kept in a subpath (`@medidata/shared/logger`) so the browser bundle never
 * pulls in pino or references Node globals such as `process`.
 */
import { pino } from 'pino';

export const logger = pino({
  name: 'medidata',
  level: (typeof process !== 'undefined' && process.env?.LOG_LEVEL) || 'info',
});
