/**
 * Load backend/.env before any module reads `process.env`.
 *
 * `@medidata/db` owns the zero-dependency loader (packages/db/src/env.ts);
 * importing it here guarantees DATABASE_URL/JWT_SECRET/etc. are present before
 * `config.ts` validates the environment.
 */
import { loadBackendEnv } from '@medidata/db';

loadBackendEnv();
