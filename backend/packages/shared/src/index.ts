/**
 * @medidata/shared — canonical API contract.
 *
 * NOTE: `types.ts` and `constants.ts` both export a `Role` type. The barrel
 * re-exports the type from types.ts (same underlying shape: a string union of
 * the ROLES values), so consumers get one consistent `Role`.
 */
export * from './schemas.js';
export * from './types.js';
export {
  API_BASE,
  API_PORT,
  WEB_PORT,
  ROLES,
  ENDPOINTS,
  SCOPE_PROFILE,
  IS_BILLING_SCOPE,
  type Role as RoleName,
} from './constants.js';

// NOTE: the pino logger lives at `@medidata/shared/logger` on purpose. Exporting
// it from this barrel would bundle pino (and Node's `process`) into the browser.

